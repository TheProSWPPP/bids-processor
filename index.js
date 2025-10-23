const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const XmlStream = require('xml-stream');
const { Readable } = require('stream');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    }
});

app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: 'Zip processor is running'
    });
});

async function fetchAllPipedriveLeads(apiToken) {
    const allLeads = [];
    let start = 0;
    const limit = 500;
    const filterId = 127;
    console.log('Fetching Pipedrive leads...');
    while (true) {
        const url = `https://api.pipedrive.com/v1/leads?api_token=${apiToken}&filter_id=${filterId}&archived_status=not_archived&limit=${limit}&start=${start}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (!data.success || !data.data || data.data.length === 0) break;
            allLeads.push(...data.data);
            console.log(`Fetched ${data.data.length} leads (total: ${allLeads.length})`);
            if (!data.additional_data?.pagination?.more_items_in_collection) break;
            start = data.additional_data.pagination.next_start;
        } catch (error) {
            console.error('Error fetching Pipedrive leads:', error.message);
            throw error;
        }
    }
    console.log(`Total Pipedrive leads fetched: ${allLeads.length}`);
    return allLeads;
}

function extractProjectId(url) {
    if (!url) return null;
    const match = url.match(/\/(\d+)\/\d+\/?/);
    return match ? match[1] : null;
}

function mapProjectStage(stage) {
    if (!stage) return stage;
    if (['Pre-Bid', 'Bid Date Set', 'Biddate Set', 'Schematic Design', 'Design Development'].includes(stage)) return 'Pre-Bid';
    if (['Open Bid', 'SUBBIDS: ASAP'].includes(stage)) return 'OB';
    if (['Low Bid Apparent', 'Low Bid / Apparent', 'Low Bids Announced'].includes(stage)) return 'LBA';
    if (['Post-Bid - General Contractor Award', 'Architectural General Contracting', 'General Contractor Award'].includes(stage)) return 'AGC';
    if (stage === 'Post Bid') return 'PB';
    if (['General Contract', 'Construction Underway'].includes(stage)) return 'GC';
    if (stage === 'Construction Manager') return 'CM';
    if (['Construction Documents', 'Pre-Design'].includes(stage)) return 'CD';
    return stage;
}

// *** THIS IS THE CORRECTED FUNCTION THAT MERGES COMPANIES - WITH DEBUG LOGGING ***
function matchLeadsWithProjects(pipedriveLeads, railwayProjects) {
    const railwayProjectMap = new Map();
    const projectOccurrences = new Map(); // Track how many times we see each project

    railwayProjects.forEach(p => {
        const projectId = extractProjectId(p.URL);
        if (!projectId) return;

        // Track occurrences
        projectOccurrences.set(projectId, (projectOccurrences.get(projectId) || 0) + 1);

        if (railwayProjectMap.has(projectId)) {
            // Project exists, so merge companies
            const existingProject = railwayProjectMap.get(projectId);
            const beforeCount = existingProject.companies.length;
            const existingCompanyIds = new Set(existingProject.companies.map(c => c.CompanyID));

            // Add new, unique companies from the current project 'p'
            if (p.companies) {
                p.companies.forEach(newCompany => {
                    if (!existingCompanyIds.has(newCompany.CompanyID)) {
                        existingProject.companies.push(newCompany);
                        existingCompanyIds.add(newCompany.CompanyID);
                    }
                });
            }

            const afterCount = existingProject.companies.length;
            if (afterCount > beforeCount) {
                console.log(`  Merged companies for project ${projectId}: ${beforeCount} → ${afterCount}`);
            }

            // Update the main project record if the new one is more recent
            if (new Date(p.UpdateDate) > new Date(existingProject.UpdateDate)) {
                const mergedCompanies = existingProject.companies; // Keep the merged company list
                Object.assign(existingProject, p, { companies: mergedCompanies });
            }
        } else {
            // First time seeing this project, add it to the map
            railwayProjectMap.set(projectId, p);
        }
    });

    // Log projects that appeared multiple times
    const duplicates = Array.from(projectOccurrences.entries()).filter(([id, count]) => count > 1);
    if (duplicates.length > 0) {
        console.log(`\n📊 Projects with multiple entries (company merging happened):`);
        duplicates.slice(0, 10).forEach(([id, count]) => {
            const project = railwayProjectMap.get(id);
            console.log(`  - Project ${id}: appeared ${count} times, merged to ${project.companies.length} companies`);
        });
        if (duplicates.length > 10) {
            console.log(`  ... and ${duplicates.length - 10} more`);
        }
    } else {
        console.log(`\n⚠️  No duplicate projects found - each project appears only once in the XML`);
    }

    console.log(`Railway projects mapped (after merging): ${railwayProjectMap.size}`);
    const matches = [];
    for (const lead of pipedriveLeads) {
        const pipedriveUrl = lead["3fea11727cd0340a9eb1c3d18e0d4d15151fad38"];
        if (pipedriveUrl) {
            const pipedriveProjectId = extractProjectId(pipedriveUrl);
            if (!pipedriveProjectId || !railwayProjectMap.has(pipedriveProjectId)) continue;

            const matchedProject = railwayProjectMap.get(pipedriveProjectId);
            const railwayMappedStage = mapProjectStage(matchedProject.Stage);
            const pipedriveStage = lead["7c1852c27664d1118f75660223a6af9e99d10f2c"];

            if (pipedriveStage !== railwayMappedStage) {
                matches.push({
                    lead,
                    matchedProject,
                    projectId: pipedriveProjectId,
                    pipedriveStage,
                    railwayStage: matchedProject.Stage,
                    railwayMappedStage,
                    stageChanged: true
                });
            }
        }
    }
    console.log(`Matches with DIFFERENT stages found: ${matches.length}`);
    return matches;
}

/**
 * Process XML file using streaming parser to handle large files
 */
async function processXmlStream(stream, fileName) {
    return new Promise((resolve, reject) => {
        const projects = [];
        const xml = new XmlStream(stream);
        
        let projectCount = 0;
        let lastLog = Date.now();

        xml.on('endElement: Project', (project) => {
            projectCount++;
            
            // Log every 1000 projects OR every 5 seconds
            const now = Date.now();
            if (projectCount % 1000 === 0 || now - lastLog > 5000) {
                console.log(`Processing ${fileName}: ${projectCount} projects...`);
                lastLog = now;
            }

            try {
                const cleanedProject = cleanProject(project, projectCount === 1); // Debug first project only
                projects.push(cleanedProject);
            } catch (err) {
                console.error(`Error cleaning project ${projectCount} in ${fileName}:`, err.message);
            }
        });

        xml.on('end', () => {
            console.log(`✓ Completed ${fileName}: ${projects.length} projects total`);
            resolve(projects);
        });

        xml.on('error', (err) => {
            console.error(`✗ Stream error for ${fileName}:`, err.message);
            reject(err);
        });
    });
}

/**
 * Clean a single project node from the XML stream - WITH DEBUG LOGGING
 */
function cleanProject(project, debug = false) {
    const cleanedProject = { ...project.$ };

    // DEBUG: Log the raw project structure for first project only
    if (debug && project.Companies) {
        console.log(`\n=== DEBUG Project ${cleanedProject.ProjectID} ===`);
        
        if (project.Companies.Company) {
            const isArray = Array.isArray(project.Companies.Company);
            const count = isArray ? project.Companies.Company.length : 1;
            console.log(`Companies.Company is ${isArray ? 'ARRAY' : 'OBJECT'} with ${count} item(s)`);
            
            // Show first few company names
            if (isArray && project.Companies.Company.length > 0) {
                console.log('First 3 companies:');
                project.Companies.Company.slice(0, 3).forEach((c, i) => {
                    console.log(`  ${i + 1}. ${c.$?.Name || 'Unknown'} (${c.$?.Role || c.$?.BiddingRole || 'No role'})`);
                });
            } else if (!isArray) {
                console.log(`Single company: ${project.Companies.Company.$?.Name || 'Unknown'}`);
            }
        } else {
            console.log('WARNING: Companies exists but Company is undefined!');
        }
    }

    const getContacts = (c) => {
        if (!c || !c.Contacts || !c.Contacts.Contact) return [];
        const contacts = Array.isArray(c.Contacts.Contact) ? c.Contacts.Contact : [c.Contacts.Contact];
        return contacts.map(contact => ({
            ...contact.$,
            ...(contact.Email && { email: contact.Email }),
            ...(contact.PhoneNumber && { phone: contact.PhoneNumber }),
            ...(contact.LinkedInURL && { linkedin: contact.LinkedInURL }),
        }));
    };

    const getAddress = (c) => {
        if (!c || !c.Addresses || !c.Addresses.Address) return null;
        const addressRaw = Array.isArray(c.Addresses.Address) ? c.Addresses.Address[0] : c.Addresses.Address;
        if (!addressRaw) return null;
        return {
            ...addressRaw.$,
            addressLine1: addressRaw.AddressLine1,
            addressLine2: addressRaw.AddressLine2,
            city: addressRaw.City,
            state: addressRaw.StateProvince,
            zip: addressRaw.ZipPostalCode,
            county: addressRaw.County,
        };
    };

    const getPhones = (c) => {
        if (!c || !c.Phones || !c.Phones.Phone) return [];
        const phones = Array.isArray(c.Phones.Phone) ? c.Phones.Phone : [c.Phones.Phone];
        return phones.map(phone => ({
            type: phone.$?.PhoneType,
            number: phone.$children?.[0] || phone._
        }));
    };

    cleanedProject.companies = []; // Initialize as empty
    if (project.Companies && project.Companies.Company) {
        const companiesRaw = Array.isArray(project.Companies.Company) ? project.Companies.Company : [project.Companies.Company];
        
        if (debug) {
            console.log(`Processing ${companiesRaw.length} companies for project ${cleanedProject.ProjectID}`);
        }
        
        cleanedProject.companies = companiesRaw.map((company, idx) => {
            const classifications = [];
            if (company.ClassificationTypes && company.ClassificationTypes.ClassificationType) {
                const classificationsRaw = Array.isArray(company.ClassificationTypes.ClassificationType) 
                    ? company.ClassificationTypes.ClassificationType 
                    : [company.ClassificationTypes.ClassificationType];
                
                classificationsRaw.forEach(ct => {
                    classifications.push({
                        rank: ct.$?.Rank,
                        type: ct.$?.Type
                    });
                });
            }

            const cleanedCompany = {
                ...company.$,
                email: company.Email,
                website: company.Website,
                contacts: getContacts(company),
                address: getAddress(company),
                phones: getPhones(company),
                classificationTypes: classifications
            };
            
            if (debug) {
                console.log(`  Company ${idx + 1}/${companiesRaw.length}: ${company.$?.Name || 'Unknown'} (${company.$?.Role || company.$?.BiddingRole || 'No role'})`);
            }
            
            return cleanedCompany;
        });
        
        if (debug) {
            console.log(`✓ Extracted ${cleanedProject.companies.length} companies for project ${cleanedProject.ProjectID}\n`);
        }
    }

    if (project.Valuation) cleanedProject.valuation = project.Valuation.$;
    if (project.Parameters) cleanedProject.parameters = project.Parameters.$;

    return cleanedProject;
}

app.post('/process', upload.single('file'), async (req, res) => {
    console.log('=== Request received ===');
    const startTime = Date.now();
    
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded'
            });
        }
        
        const pipedriveToken = '3089d0ffb03a7f996c5f10156fd4ebfaad9fca28';
        console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        console.log('Starting unzip...');
        
        const allRailwayProjects = [];
        const stream = Readable.from(req.file.buffer);
        
        let filesProcessed = 0;
        const processingPromises = [];

        // Process the zip file with better error handling
        try {
            await new Promise((resolve, reject) => {
                const unzipStream = stream.pipe(unzipper.Parse());
                
                unzipStream.on('entry', (entry) => {
                    if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
                        console.log(`\n📄 Found XML file: ${entry.path}`);
                        
                        const promise = processXmlStream(entry, entry.path)
                            .then(projects => {
                                allRailwayProjects.push(...projects);
                                filesProcessed++;
                                console.log(`✓ Added ${projects.length} projects from ${entry.path} (Total so far: ${allRailwayProjects.length})`);
                            })
                            .catch(e => {
                                console.error(`✗ Error processing ${entry.path}:`, e.message);
                            });
                        
                        processingPromises.push(promise);
                    } else {
                        entry.autodrain();
                    }
                });
                
                unzipStream.on('error', (err) => {
                    console.error('Unzip stream error:', err);
                    reject(err);
                });
                
                unzipStream.on('close', () => {
                    console.log('\n✓ Unzip stream closed');
                    resolve();
                });
            });
        } catch (unzipError) {
            console.error('Error during unzip:', unzipError);
            throw unzipError;
        }

        // Wait for all XML processing to complete
        console.log(`\nWaiting for ${processingPromises.length} XML files to complete processing...`);
        await Promise.all(processingPromises);

        console.log(`\n=== XML Processing complete: ${filesProcessed} files ===`);
        console.log(`Total Railway projects extracted: ${allRailwayProjects.length}`);
        console.log(`Time elapsed: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
        
        console.log('\nFetching Pipedrive leads...');
        const pipedriveLeads = await fetchAllPipedriveLeads(pipedriveToken);
        
        console.log('\nMatching leads with projects...');
        const matches = matchLeadsWithProjects(pipedriveLeads, allRailwayProjects);

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n=== COMPLETE: Total time ${totalTime}s ===`);

        res.json({
            success: true,
            filesProcessed: filesProcessed,
            totalProjects: allRailwayProjects.length,
            totalLeads: pipedriveLeads.length,
            matchesFound: matches.length,
            processingTime: totalTime + 's',
            matches: matches
        });
    } catch (error) {
        console.error('\n=== FATAL ERROR ===');
        console.error('Error message:', error.message);
        console.error('Stack trace:', error.stack);
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Max heap size: ${process.env.NODE_OPTIONS || 'default'}`);
});
