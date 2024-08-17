process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});


const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fastcsv = require('fast-csv');
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));

app.post('/upload', upload.single('file'), (req, res) => {
  console.log('File upload initiated.');  // Log when the upload starts

  let results = [];
  let rowCount = 0;  // Add a counter for the number of rows

  if (!req.file) {
    console.error('No file received.');  // Log if no file is uploaded
    return res.status(400).send('No file uploaded.');
  }

  console.log(`Processing file: ${req.file.path}`);  // Log the file path being processed

  fs.createReadStream(req.file.path)
    .pipe(fastcsv.parse({ headers: true, quote: '"' }))  // using fast-csv with quote support
    .on('data', (data) => {
      results.push(data);
      rowCount++;  // Increment the row count
      console.log(`Processing row ${rowCount}`);  // Log the row count to the terminal
    })
    .on('end', () => {
      fs.unlinkSync(req.file.path);  // Delete the uploaded file
      console.log(`Finished processing. Total rows processed: ${rowCount}`);  // Log the total row count
      res.json(results);
    })
    .on('error', (err) => {
      console.error('Error during file processing:', err);  // Log any errors during processing
      res.status(500).send('Error processing file.');
    });
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
