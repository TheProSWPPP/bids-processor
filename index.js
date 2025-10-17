const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const xml2js = require('xml2js');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit - adjust as needed
  }
});
const parser = new xml2js.Parser();

// Middleware to parse JSON bodies
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Zip processor is running' });
});

/**
 * Fetch all leads from Pipedrive with pagination
 */
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
      
      if (!data.success || !data.data || data.data.length === 0) {
        break;
      }
      
      allLeads.push(...data.data);
      console.log(`Fetched ${data.data.length} leads (total: ${allLeads.length})`);
      
      // Check if there are more results
      if (!data.additional_data || !data.additional_data.pagination || !data.additional_data.pagination.more_items_in_collection) {
        break;
      }
      
      start = data.additional_data.pagination.next_start;
    } catch (error) {
      console.error('Error fetching Pipedrive leads:', error.message);
      throw error;
    }
  }
  
  console.log(`Total Pipedrive leads fetched: ${allLeads.length}`);
  return allLeads;
}

/**
 * Extract project ID from URL
 */
function extractProjectId(url) {
  if (!url) return null;
  const match = url.match(/\/(\d+)\/\d+\/?/);
  return match ? match[1] : null;
}

/**
 * Match Pipedrive leads with Railway projects
 */
function matchLeadsWithProjects(pipedriveLeads, railwayProjects) {
  // Create a Set of Railway project IDs for faster lookup
  const railwayProjectIds = new Set(
    railwayProjects.map(p => extractProjectId(p.url)).filter(id => id !== null)
  );
  
  console.log(`Railway project IDs: ${railwayProjectIds.size}`);
  
  const matches = [];
  
  for (const lead of pipedriveLeads) {
    // The custom field ID for the project URL in Pipedrive
    const pipedriveUrl = lead["3fea11727cd0340a9eb1c3d18e0d4d15151fad38"];
    const pipedriveProjectId = extractProjectId(pipedriveUrl);
    
    if (!pipedriveProjectId) continue;
    
    // Check if this project ID exists in Railway
    if (railwayProjectIds.has(pipedriveProjectId)) {
      const matchedProject = railwayProjects.find(p => extractProjectId(p.url) === pipedriveProjectId);
      matches.push({
        lead: lead,
        matchedProject: matchedProject,
        projectId: pipedriveProjectId
      });
    }
  }
  
  console.log(`Found ${matches.length} matches between Pipedrive leads and Railway projects`);
  return matches;
}

app.post('/process', upload.single('file'), async (req, res) => {
  console.log('=== Request received ===');
  
  try {
    if (!req.file) {
      console.log('ERROR: No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Use hardcoded Pipedrive API token
    const pipedriveToken = '3089d0ffb03a7f996c5f10156fd4ebfaad9fca28';

    console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);

    const xmlFiles = [];
    const { Readable } = require('stream');
    const stream = Readable.from(req.file.buffer);

    // Collect all XML processing promises
    const processingPromises = [];

    await stream
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
          console.log(`Found XML file: ${entry.path}`);
          
          // Create a promise for each XML file processing
          const processingPromise = new Promise((resolve, reject) => {
            const chunks = [];
            
            entry
              .on('data', (chunk) => chunks.push(chunk))
              .on('end', async () => {
                try {
                  const xml = Buffer.concat(chunks).toString('utf8');
                  const parsed = await parser.parseStringPromise(xml);
                  const cleaned = cleanProjectData(parsed);
                  
                  xmlFiles.push({
                    fileName: entry.path,
                    data: cleaned
                  });
                  
                  console.log(`Successfully processed: ${entry.path}`);
                  resolve();
                } catch (e) {
                  console.error(`Parse error for ${entry.path}:`, e.message);
                  resolve(); // Resolve anyway to continue processing other files
                }
              })
              .on('error', (err) => {
                console.error(`Stream error for ${entry.path}:`, err.message);
                resolve(); // Resolve anyway to continue processing
              });
          });
          
          processingPromises.push(processingPromise);
        } else {
          entry.autodrain();
        }
      })
      .promise();

    // Wait for all XML files to be processed
    await Promise.all(processingPromises);

    console.log(`=== Processing complete: ${xmlFiles.length} XML files ===`);

    // Extract all projects from XML files
    const allRailwayProjects = [];
    xmlFiles.forEach(file => {
      if (file.data.projects && Array.isArray(file.data.projects)) {
        allRailwayProjects.push(...file.data.projects);
      }
    });

    console.log(`Total Railway projects extracted: ${allRailwayProjects.length}`);

    // Fetch Pipedrive leads
    const pipedriveLeads = await fetchAllPipedriveLeads(pipedriveToken);

    // Match leads with projects
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
    console.error('=== FATAL ERROR ===');
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper function to safely ensure a value is an array.
 * @param {*} data - The data that might be a single object or an array.
 * @returns {Array} - An array representation of the data.
 */
function ensureArray(data) {
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
}

/**
 * Cleans the parsed XML data for a project, now including
 * bidder rank and a more inclusive project team (with Owners).
 * @param {object} data - The raw data object parsed from xml2js.
 * @returns {object} - A cleaned object containing project details.
 */
function cleanProjectData(data) {
  if (!data.Projects || !data.Projects.Project) {
    return data;
  }

  const projects = ensureArray(data.Projects.Project);

  const cleanedProjects = projects.map(project => {
    const cleanedProject = {
      projectId: project.$?.ProjectID,
      title: project.$?.Title,
      stage: project.$?.Stage,
      url: project.$?.URL,
      updateDate: project.$?.UpdateDate,
      updateText: project.$?.UpdateText,
      prospectiveBidders: [],
      projectTeam: []
    };

    if (project.Companies && project.Companies[0].Company) {
      const companies = ensureArray(project.Companies[0].Company);

      companies.forEach(company => {
        const getContacts = (c) => {
          const contactsRaw = ensureArray(c.Contacts?.[0]?.Contact);
          return contactsRaw.map(contact => ({
            contactId: contact.$?.ContactID,
            name: contact.$?.Name,
            email: contact.Email?.[0],
            phone: contact.PhoneNumber?.[0],
            linkedin: contact.LinkedInURL?.[0],
          })).filter(c => c.name);
        };

        const getAddress = (c) => {
          const addressRaw = ensureArray(c.Addresses?.[0]?.Address)[0];
          if (!addressRaw) return null;
          return {
            type: addressRaw.$?.AddressType,
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

        const cleanedCompany = {
          companyId: company.$?.CompanyID,
          name: company.$?.Name,
          url: company.$?.URL,
          website: company.Website?.[0],
          email: company.Email?.[0],
          contacts: getContacts(company),
          address: getAddress(company),
          phones: getPhones(company)
        };

        // Check if it's a bidder
        if (company.$?.BiddingRole) {
          cleanedCompany.role = company.$?.BiddingRole;
          cleanedCompany.rank = company.ClassificationTypes?.[0]?.ClassificationType?.[0]?.$?.Rank;
          cleanedProject.prospectiveBidders.push(cleanedCompany);
        } else {
          // Check if it's a key project team member
          const projectTeamRoles = ['Architect', 'Engineer', 'Consultant', 'Owner', 'Tenant'];
          
          let companyRole = company.$?.Role;
          if (!companyRole) {
            companyRole = company.ClassificationTypes?.[0]?.ClassificationType?.[0]?.$?.Type;
          }

          if (projectTeamRoles.includes(companyRole)) {
            cleanedCompany.role = companyRole;
            cleanedProject.projectTeam.push(cleanedCompany);
          }
        }
      });
    }

    return cleanedProject;
  });

  return { projects: cleanedProjects };
}

const PORT = process.env.PORT || 3080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
