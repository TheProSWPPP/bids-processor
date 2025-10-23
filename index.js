const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const XmlStream = require('xml-stream');
const { Readable } = require('stream');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
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

function matchLeadsWithProjects(pipedriveLeads, railwayProjects) {
    const railwayProjectMap = new Map();
    railwayProjects.forEach(p => {
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

        xml.on('endElement: Project', (project) => {
            projectCount++;
            if (projectCount % 1000 === 0) {
                console.log(`Processing ${fileName}: ${projectCount} projects...`);
            }

            const cleanedProject = cleanProject(project);
            projects.push(cleanedProject);
        });

        xml.on('end', () => {
            console.log(`Completed ${fileName}: ${projects.length} projects total`);
            resolve(projects);
        });

        xml.on('error', (err) => {
            console.error(`Stream error for ${fileName}:`, err.message);
            reject(err);
        });
    });
}

/**
 * Clean a single project node from the XML stream
 */
function cleanProject(project) {
    const cleanedProject = { ...project.$ };

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

    if (project.Companies && project.Companies.Company) {
        const companiesRaw = Array.isArray(project.Companies.Company) ? project.Companies.Company : [project.Companies.Company];
        
        cleanedProject.companies = companiesRaw.map(company => {
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

            return {
                ...company.$,
                email: company.Email,
                website: company.Website,
                contacts: getContacts(company),
                address: getAddress(company),
                phones: getPhones(company),
                classificationTypes: classifications
            };
        });
    }

    if (project.Valuation) cleanedProject.valuation = project.Valuation.$;
    if (project.Parameters) cleanedProject.parameters = project.Parameters.$;

    return cleanedProject;
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
        
        const allRailwayProjects = [];
        const stream = Readable.from(req.file.buffer);
        
        let filesProcessed = 0;

        await stream.pipe(unzipper.Parse()).on('entry', async (entry) => {
            if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
                console.log(`Processing XML file: ${entry.path}`);
                try {
                    const projects = await processXmlStream(entry, entry.path);
                    allRailwayProjects.push(...projects);
                    filesProcessed++;
                } catch (e) {
                    console.error(`Parse error for ${entry.path}:`, e.message);
                }
            } else {
                entry.autodrain();
            }
        }).promise();

        console.log(`=== Processing complete: ${filesProcessed} XML files ===`);
        console.log(`Total Railway projects extracted: ${allRailwayProjects.length}`);
        
        const pipedriveLeads = await fetchAllPipedriveLeads(pipedriveToken);
        const matches = matchLeadsWithProjects(pipedriveLeads, allRailwayProjects);

        res.json({
            success: true,
            filesProcessed: filesProcessed,
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

const PORT = process.env.PORT || 3080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
