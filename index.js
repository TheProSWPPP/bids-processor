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

app.get('/', (req, res) => {
  res.json({ status: 'Zip processor is running' });
});

app.post('/process', upload.single('file'), async (req, res) => {
  console.log('=== Request received ===');
  
  try {
    if (!req.file) {
      console.log('ERROR: No file uploaded');
      return res.status(400).json({ error: 'No file uploaded' });
    }

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

    console.log(`=== Processing complete: ${xmlFiles.length} files ===`);

    res.json({
      success: true,
      filesProcessed: xmlFiles.length,
      data: xmlFiles
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
