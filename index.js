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

function cleanProjectData(data) {
  if (!data.Projects || !data.Projects.Project) {
    return data;
  }

  const projects = Array.isArray(data.Projects.Project) 
    ? data.Projects.Project 
    : [data.Projects.Project];

  const cleanedProjects = projects.map(project => ({
    projectId: project.$?.ProjectID,
    title: project.$?.Title,
    stage: project.$?.Stage,
    url: project.$?.URL,
    updateDate: project.$?.UpdateDate,
    updateText: project.$?.UpdateText
  }));

  return { projects: cleanedProjects };
}

const PORT = process.env.PORT || 3080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
