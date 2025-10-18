const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const xml2js = require('xml2js');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});
const parser = new xml2js.Parser();

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
    if (['Pre-Bid', 'Bid Date Set', 'Biddate Set', 'Schematic Design', 'Design Development'].includes(stage)) return 'Bid Date Set';
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
    railwayProjects.forEach(p => {
        // The project object now has URL directly from the attributes
        const projectId = extractProjectId(p.URL);
        if (projectId) {
            railwayProjectMap.set(projectId, p);
        }
    });
    console.log(`Railway projects mapped: ${railwayProjectMap.size}`);
    const matches = [];
    for (const lead of pipedriveLeads) {
        const pipedriveUrl = lead["3fea11727cd0340a9eb1c3d18e0d4d15151fad38"];
        if (pipedriveUrl) {
            const pipedriveProjectId = extractProjectId(pipedriveUrl);
            if (!pipedriveProjectId || !railwayProjectMap.has(pipedriveProjectId)) continue;

            const matchedProject = railwayProjectMap.get(pipedriveProjectId);
            const railwayMappedStage = mapProjectStage(matchedProject.Stage); // Note: Property name is now 'Stage'
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

app.post('/process', upload.single('file'), async (req, res) => {
    console.log('=== Request received ===');
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'No file uploaded'
            });
        }
        const pipedriveToken = '3089d0ffb03a7f996c5f10156fd4ebfaad9fca28';
        console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        const xmlFiles = [];
        const {
            Readable
        } = require('stream');
        const stream = Readable.from(req.file.buffer);
        const processingPromises = [];
        await stream.pipe(unzipper.Parse()).on('entry', (entry) => {
            if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
                const processingPromise = new Promise((resolve) => {
                    const chunks = [];
                    entry.on('data', (chunk) => chunks.push(chunk)).on('end', async () => {
                        try {
                            const xml = Buffer.concat(chunks).toString('utf8');
                            const parsed = await parser.parseStringPromise(xml);
                            const cleaned = cleanProjectData(parsed);
                            xmlFiles.push({
                                fileName: entry.path,
                                data: cleaned
                            });
                        } catch (e) {
                            console.error(`Parse error for ${entry.path}:`, e.message);
                        }
                        resolve();
                    }).on('error', (err) => {
                        console.error(`Stream error for ${entry.path}:`, err.message);
                        resolve();
                    });
                });
                processingPromises.push(processingPromise);
            } else {
                entry.autodrain();
            }
        }).promise();
        await Promise.all(processingPromises);
        console.log(`=== Processing complete: ${xmlFiles.length} XML files ===`);
        const allRailwayProjects = [];
        xmlFiles.forEach(file => {
            if (file.data.projects && Array.isArray(file.data.projects)) {
                allRailwayProjects.push(...file.data.projects);
            }
        });
        console.log(`Total Railway projects extracted: ${allRailwayProjects.length}`);
        const pipedriveLeads = await fetchAllPipedriveLeads(pipedriveToken);
        const matches = matchLeadsWithProjects(pipedriveLeads, allRailwayProjects);
        res.json({
            success: true,
            filesProcessed: xmlFiles.length,
            totalProjects: allRailwayProjects.length,
            totalLeads: pipedriveLeads.length,
            matchesFound: matches.length,
            matches: matches
        });
    } catch (error) {
        console.error('=== FATAL ERROR ===', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * Helper function to safely ensure a value is an array.
 */
function ensureArray(data) {
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
}

/**
 * Cleans the parsed XML data into a structured JSON format.
 * This version returns all available fields for every company in a single 'companies'
 * array, including all attributes and classification types, without attempting
 * to categorize them.
 */
function cleanProjectData(data) {
    if (!data.Projects || !data.Projects.Project) {
        return data;
    }

    const projects = ensureArray(data.Projects.Project);

    const cleanedProjects = projects.map(project => {
        // Start with all top-level project attributes
        const cleanedProject = { ...project.$ };

        // Helper functions
        const getContacts = (c) => {
            const contactsRaw = ensureArray(c.Contacts?.[0]?.Contact);
            return contactsRaw.map(contact => ({
                ...contact.$, // Include all attributes like ContactID and Name
                ...(contact.Email && { email: contact.Email[0] }),
                ...(contact.PhoneNumber && { phone: contact.PhoneNumber[0] }),
                ...(contact.LinkedInURL && { linkedin: contact.LinkedInURL[0] }),
            }));
        };

        const getAddress = (c) => {
            const addressRaw = ensureArray(c.Addresses?.[0]?.Address)[0];
            if (!addressRaw) return null;
            return {
                ...addressRaw.$,
                addressLine1: addressRaw.AddressLine1?.[0],
                addressLine2: addressRaw.AddressLine2?.[0],
                city: addressRaw.City?.[0],
                state: addressRaw.StateProvince?.[0],
                zip: addressRaw.ZipPostalCode?.[0],
                county: addressRaw.County?.[0],
            };
        };

        const getPhones = (c) => {
            const phonesRaw = ensureArray(c.Phones?.[0]?.Phone);
            return phonesRaw.map(phone => ({
                type: phone.$?.PhoneType,
                number: phone._
            }));
        };

        const companiesRaw = ensureArray(project.Companies?.[0]?.Company);
        
        // Create a single 'companies' array
        cleanedProject.companies = companiesRaw.map(company => {
            const classificationsRaw = ensureArray(company.ClassificationTypes?.[0]?.ClassificationType);
            const classifications = classificationsRaw.map(ct => ({
                rank: ct.$?.Rank,
                type: ct.$?.Type
            }));

            // Return a comprehensive company object
            return {
                ...company.$, // Captures all attributes like CompanyID, Role, BiddingRole
                website: company.Website?.[0],
                contacts: getContacts(company),
                address: getAddress(company),
                phones: getPhones(company),
                classificationTypes: classifications
            };
        });

        // Add other project-level details if they exist
        if(project.Valuation) cleanedProject.valuation = project.Valuation[0].$;
        if(project.Parameters) cleanedProject.parameters = project.Parameters[0].$;

        return cleanedProject;
    });

    return {
        projects: cleanedProjects
    };
}


const PORT = process.env.PORT || 3080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
