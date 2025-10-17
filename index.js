const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const xml2js = require('xml2js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const parser = new xml2js.Parser();

app.get('/', (req, res) => {
  res.json({ status: 'Zip processor is running' });
});

app.post('/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const xmlFiles = [];
    const { Readable } = require('stream');
    const stream = Readable.from(req.file.buffer);

    await stream
      .pipe(unzipper.Parse())
      .on('entry', async (entry) => {
        if (entry.type === 'File' && entry.path.toLowerCase().endsWith('.xml')) {
          const chunks = [];
          await new Promise((resolve) => {
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
                } catch (e) {
                  console.error('Parse error:', e);
                }
                resolve();
              })
              .on('error', resolve);
          });
        } else {
          entry.autodrain();
        }
      })
      .promise();

    res.json({
      success: true,
      filesProcessed: xmlFiles.length,
      data: xmlFiles
    });
  } catch (error) {
    console.error('Error:', error);
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
 * UPDATED: Cleans the parsed XML data for a project, now including
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
      projectTeam: [] // Renamed from designTeam
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

        // --- UPDATED LOGIC ---
        // 1. Check if it's a bidder
        if (company.$?.BiddingRole) {
          cleanedCompany.role = company.$?.BiddingRole;
          // Extract the rank
          cleanedCompany.rank = company.ClassificationTypes?.[0]?.ClassificationType?.[0]?.$?.Rank;
          cleanedProject.prospectiveBidders.push(cleanedCompany);
        } else {
          // 2. If not a bidder, check if it's a key project team member
          const projectTeamRoles = ['Architect', 'Engineer', 'Consultant', 'Owner', 'Tenant'];
          
          // The role can be in the <Company> attribute OR in ClassificationTypes
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
