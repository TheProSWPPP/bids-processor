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

// Military/Government configuration
const USACE_LABEL_ID = "af445200-52d4-11f0-9b10-b91edfc9ee3a";

const militaryKeywords = [
    'US Navy',
    'Naval Facilities Engineering',
    'NAVFAC',
    'USACE',
    'US Army Corps of Engineers',
    'Army Corps of Engineers',
    'US Army',
    'U.S. Army',
    'Air Force',
    'US Air Force',
    'U.S. Air Force',
    'Marine Corps',
    'US Marine Corps',
    'U.S. Marine Corps',
    'National Guard',
    'Department of Defense',
    'DOD',
    'Department of the Navy',
    'Department of the Army',
    'Department of the Air Force'
];

function isMilitaryOwner(companyName) {
    if (!companyName) return false;
    const nameLower = companyName.toLowerCase();
    return militaryKeywords.some(keyword => nameLower.includes(keyword.toLowerCase()));
}

function getMilitaryBranch(companyName) {
    if (!companyName) return null;
    const nameLower = companyName.toLowerCase();
    
    if (nameLower.includes('navy') || nameLower.includes('navfac') || nameLower.includes('naval facilities')) {
        return 'US Navy';
    }
    if (nameLower.includes('usace') || nameLower.includes('army corps of engineers')) {
        return 'USACE';
    }
    if (nameLower.includes('air force')) {
        return 'US Air Force';
    }
    if (nameLower.includes('marine corps')) {
        return 'US Marine Corps';
    }
    if (nameLower.includes('army') && !nameLower.includes('corps')) {
        return 'US Army';
    }
    if (nameLower.includes('national guard')) {
        return 'National Guard';
    }
    return 'Military/Government';
}

function checkMilitaryOwner(project) {
    if (!project?.companies || !Array.isArray(project.companies)) {
        return { hasMilitaryOwner: false, militaryBranch: null, militaryOwnerName: null };
    }
    
    const militaryOwner = project.companies.find(company => 
        company.Role === 'Owner' && isMilitaryOwner(company.Name)
    );
    
    if (militaryOwner) {
        return {
            hasMilitaryOwner: true,
            militaryOwnerName: militaryOwner.Name,
            militaryBranch: getMilitaryBranch(militaryOwner.Name)
        };
    }
    
    return { hasMilitaryOwner: false, militaryBranch: null, militaryOwnerName: null };
}

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

function matchLeadsWithProjects(pipedriveLeads, railwayProjects) {
    const railwayProjectMap = new Map();
    const projectOccurrences = new Map();

    railwayProjects.forEach(p => {
        const projectId = extractProjectId(p.URL);
        if (!projectId) return;

        projectOccurrences.set(projectId, (projectOccurrences.get(projectId) || 0) + 1);

        if (railwayProjectMap.has(projectId)) {
            const existingProject = railwayProjectMap.get(projectId);
            const beforeCount = existingProject.companies.length;
            const existingCompanyIds = new Set(existingProject.companies.map(c => c.CompanyID));

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

            if (new Date(p.UpdateDate) > new Date(existingProject.UpdateDate)) {
                const mergedCompanies = existingProject.companies;
                Object.assign(existingProject, p, { companies: mergedCompanies });
            }
        } else {
            railwayProjectMap.set(projectId, p);
        }
    });

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
    const newUsaceDetected = [];
    
    for (const lead of pipedriveLeads) {
        const pipedriveUrl = lead["3fea11727cd0340a9eb1c3d18e0d4d15151fad38"];
        if (pipedriveUrl) {
            const pipedriveProjectId = extractProjectId(pipedriveUrl);
            if (!pipedriveProjectId || !railwayProjectMap.has(pipedriveProjectId)) continue;

            const matchedProject = railwayProjectMap.get(pipedriveProjectId);
            const railwayMappedStage = mapProjectStage(matchedProject.Stage);
            const pipedriveStage = lead["7c1852c27664d1118f75660223a6af9e99d10f2c"];
            
            // Check for military owner
            const militaryCheck = checkMilitaryOwner(matchedProject);
            
            // Check if this is a NEW military detection (not already flagged)
            const alreadyFlagged = (lead.label_ids || []).includes(USACE_LABEL_ID);
            
            if (militaryCheck.hasMilitaryOwner && !alreadyFlagged) {
                newUsaceDetected.push({
                    lead,
                    matchedProject,
                    projectId: pipedriveProjectId,
                    militaryBranch: militaryCheck.militaryBranch,
                    militaryOwnerName: militaryCheck.militaryOwnerName
                });
            }

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
    console.log(`🏛️  New military/government owners detected (not already flagged): ${newUsaceDetected.length}`);
    
    if (newUsaceDetected.length > 0) {
        console.log(`\n🏛️  NEW USACE/MILITARY PROJECTS:`);
        newUsaceDetected.forEach(item => {
            console.log(`  - ${item.militaryBranch}: ${item.militaryOwnerName} (Lead: ${item.lead.id})`);
        });
    }
    
    return { matches, newUsaceDetected };
}

async function processXmlStream(stream, fileName) {
    return new Promise((resolve, reject) => {
        const projects = [];
        const xml = new XmlStream(stream);
        
        xml.collect('Company');
        xml.collect('Contact');
        xml.collect('Address');
        xml.collect('Phone');
        xml.collect('ClassificationType');
        xml.collect('ParticipantRole');
        xml.collect('Bidder');
        
        let projectCount = 0;
        let lastLog = Date.now();

        xml.on('endElement: Project', (project) => {
            projectCount++;
            
            const now = Date.now();
            if (projectCount % 1000 === 0 || now - lastLog > 5000) {
                console.log(`Processing ${fileName}: ${projectCount} projects...`);
                lastLog = now;
            }

            try {
                const cleanedProject = cleanProject(project, projectCount === 1);
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

function cleanProject(project, debug = false) {
    const cleanedProject = { ...project.$ };

    if (debug && project.Companies) {
        console.log(`\n=== DEBUG Project ${cleanedProject.ProjectID} ===`);
        
        if (project.Companies.Company) {
            const isArray = Array.isArray(project.Companies.Company);
            const count = isArray ? project.Companies.Company.length : 1;
            console.log(`Companies.Company is ${isArray ? 'ARRAY' : 'OBJECT'} with ${count} item(s)`);
            
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
            number: phone.$text
        }));
    };

    const getParticipantRoles = (c) => {
        if (!c || !c.ParticipantRoles || !c.ParticipantRoles.ParticipantRole) return [];
        const roles = Array.isArray(c.ParticipantRoles.ParticipantRole) ? c.ParticipantRoles.ParticipantRole : [c.ParticipantRoles.ParticipantRole];
        return roles.map(role => role.$);
    };

    const getBidderRoles = (c) => {
        if (!c || !c.BidderRoles || !c.BidderRoles.Bidder) return [];
        const roles = Array.isArray(c.BidderRoles.Bidder) ? c.BidderRoles.Bidder : [c.BidderRoles.Bidder];
        return roles.map(role => role.$);
    };

    cleanedProject.companies = [];
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
                classificationTypes: classifications,
                participantRoles: getParticipantRoles(company),
                bidderRoles: getBidderRoles(company)
            };
            
            if (debug) {
                console.log(`  Company ${idx + 1}/${companiesRaw.length}: ${company.$?.Name || 'Unknown'} (${company.$?.Role || company.$?.BiddingRole || 'No role'}) - Email: ${company.Email || 'NONE'}`);
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
        
        const allRailwayProjects = [];
        const stream = Readable.from(req.file.buffer);
        
        let filesProcessed = 0;
        const processingPromises = [];

        await stream.pipe(unzipper.Parse()).on('entry', (entry) => {
            if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
                console.log(`\n📄 Processing XML file: ${entry.path}`);
                const promise = processXmlStream(entry, entry.path)
                    .then(projects => {
                        allRailwayProjects.push(...projects);
                        filesProcessed++;
                    })
                    .catch(e => {
                        console.error(`✗ Error processing ${entry.path}:`, e.message);
                    });
                processingPromises.push(promise);
            } else {
                entry.autodrain();
            }
        }).promise();

        await Promise.all(processingPromises);

        console.log(`\n=== XML Processing complete: ${filesProcessed} files ===`);
        console.log(`Total Railway projects extracted: ${allRailwayProjects.length}`);
        
        const pipedriveLeads = await fetchAllPipedriveLeads(pipedriveToken);
        const { matches, newUsaceDetected } = matchLeadsWithProjects(pipedriveLeads, allRailwayProjects);

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n=== COMPLETE: Total time ${totalTime}s ===`);

        res.json({
            success: true,
            filesProcessed: filesProcessed,
            totalProjects: allRailwayProjects.length,
            totalLeads: pipedriveLeads.length,
            matchesFound: matches.length,
            processingTime: totalTime + 's',
            matches: matches,
            newUsaceDetected: newUsaceDetected
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
});
