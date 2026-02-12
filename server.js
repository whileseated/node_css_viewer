const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' })); // Increase body size limit for large CSV files

// Storage configuration for multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'saved_csvs');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    // Sanitize filename - remove special characters, keep only alphanumeric, dots, dashes, underscores
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-_]/g, '_');
    cb(null, sanitized);
  }
});

// File filter to only allow CSV, TSV, and TXT files
const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.csv', '.tsv', '.txt'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV, TSV, and TXT files are allowed'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Paths
const SAVED_CSV_DIR = path.join(__dirname, 'saved_csvs');
const METADATA_FILE = path.join(SAVED_CSV_DIR, 'metadata.json');

// Helper function to read metadata
async function readMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist or is invalid, return empty object
    return {};
  }
}

// Helper function to write metadata
async function writeMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9.-_]/g, '_');
}

function countQueryMatches(content, query) {
  if (!content || !query) return 0;
  let count = 0;
  let index = 0;
  const limit = 1000;

  while ((index = content.indexOf(query, index)) !== -1) {
    count += 1;
    if (count >= limit) break;
    index += query.length || 1;
  }

  return count;
}

// Helper function to sync metadata with actual files on disk
async function syncMetadataWithFiles() {
  try {
    const metadata = await readMetadata();
    const files = await fs.readdir(SAVED_CSV_DIR);

    // Remove metadata entries for files that don't exist
    let changed = false;
    for (const filename of Object.keys(metadata)) {
      // Skip metadata.json itself and check if the actual CSV file exists
      if (filename !== 'metadata.json' && !files.includes(filename)) {
        delete metadata[filename];
        changed = true;
        console.log(`Removed orphaned metadata entry: ${filename}`);
      }
    }

    if (changed) {
      await writeMetadata(metadata);
      console.log('Metadata synchronized with files on disk');
    }
  } catch (error) {
    console.error('Error syncing metadata:', error);
  }
}

// API Endpoints

// GET /api/saved-files - List all saved CSV files
app.get('/api/saved-files', async (req, res) => {
  try {
    const metadata = await readMetadata();

    // Validate that each file actually exists before including it
    const fileList = [];
    for (const filename of Object.keys(metadata)) {
      const filePath = path.join(SAVED_CSV_DIR, filename);
      try {
        await fs.access(filePath);
        // File exists, include it in the list
        fileList.push({
          filename: filename,
          ...metadata[filename]
        });
      } catch {
        // File doesn't exist, skip it (it will be cleaned up on next server restart)
        console.warn(`Skipping missing file in metadata: ${filename}`);
      }
    }

    // Sort by lastModified descending (newest first)
    fileList.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    res.json({ success: true, files: fileList });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ success: false, error: 'Failed to list files' });
  }
});

// GET /api/saved-files/search - Search saved CSV files by content
app.get('/api/saved-files/search', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (!query) {
      return res.status(400).json({ success: false, error: 'Search query is required' });
    }

    const metadata = await readMetadata();
    const normalizedQuery = query.toLowerCase();
    const results = [];

    for (const [filename, info] of Object.entries(metadata)) {
      if (filename === 'metadata.json') continue;
      const filePath = path.join(SAVED_CSV_DIR, filename);

      try {
        await fs.access(filePath);
      } catch {
        continue;
      }

      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        console.warn(`Unable to read file for search: ${filename}`, error);
        continue;
      }

      const matchCount = countQueryMatches(content.toLowerCase(), normalizedQuery);
      if (matchCount > 0) {
        results.push({
          filename: filename,
          matchCount: matchCount,
          ...info
        });
      }
    }

    res.json({ success: true, files: results });
  } catch (error) {
    console.error('Error searching files:', error);
    res.status(500).json({ success: false, error: 'Failed to search files' });
  }
});

// POST /api/upload - Upload and save a new CSV file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const metadata = await readMetadata();
    const filename = req.file.filename;

    // Check if file already exists
    if (metadata[filename]) {
      // Update existing file metadata
      metadata[filename].lastModified = new Date().toISOString();
      metadata[filename].size = req.file.size;
    } else {
      // Add new file metadata
      metadata[filename] = {
        originalName: req.file.originalname,
        savedName: filename,
        uploadedAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        size: req.file.size
      };
    }

    await writeMetadata(metadata);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: filename
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload file' });
  }
});

// GET /api/file/:filename - Download a specific saved CSV file
app.get('/api/file/:filename', async (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    const filePath = path.join(SAVED_CSV_DIR, filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Send file
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ success: false, error: 'Failed to download file' });
  }
});

// PUT /api/rename/:filename - Rename a saved CSV file
app.put('/api/rename/:filename', async (req, res) => {
  try {
    const oldFilename = sanitizeFilename(req.params.filename);
    const newFilename = sanitizeFilename(req.body.newFilename);

    if (!newFilename) {
      return res.status(400).json({ success: false, error: 'New filename is required' });
    }

    const oldPath = path.join(SAVED_CSV_DIR, oldFilename);
    const newPath = path.join(SAVED_CSV_DIR, newFilename);

    // Check if old file exists
    try {
      await fs.access(oldPath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Check if new filename already exists
    try {
      await fs.access(newPath);
      return res.status(400).json({ success: false, error: 'A file with that name already exists' });
    } catch {
      // File doesn't exist, which is good
    }

    // Rename file
    await fs.rename(oldPath, newPath);

    // Update metadata
    const metadata = await readMetadata();
    if (metadata[oldFilename]) {
      metadata[newFilename] = {
        ...metadata[oldFilename],
        savedName: newFilename,
        lastModified: new Date().toISOString()
      };
      delete metadata[oldFilename];
      await writeMetadata(metadata);
    }

    res.json({
      success: true,
      message: 'File renamed successfully',
      newFilename: newFilename
    });
  } catch (error) {
    console.error('Error renaming file:', error);
    res.status(500).json({ success: false, error: 'Failed to rename file' });
  }
});

// DELETE /api/delete/:filename - Delete a saved CSV file
app.delete('/api/delete/:filename', async (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    const filePath = path.join(SAVED_CSV_DIR, filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Delete file
    await fs.unlink(filePath);

    // Update metadata
    const metadata = await readMetadata();
    if (metadata[filename]) {
      delete metadata[filename];
      await writeMetadata(metadata);
    }

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

// PUT /api/update/:filename - Update the content of a saved CSV file
app.put('/api/update/:filename', async (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    const filePath = path.join(SAVED_CSV_DIR, filename);
    const csvContent = req.body.content;

    if (!csvContent) {
      return res.status(400).json({ success: false, error: 'No content provided' });
    }

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Write new content to file
    await fs.writeFile(filePath, csvContent, 'utf8');

    // Update metadata
    const metadata = await readMetadata();
    if (metadata[filename]) {
      metadata[filename].lastModified = new Date().toISOString();
      metadata[filename].size = Buffer.byteLength(csvContent, 'utf8');
      await writeMetadata(metadata);
    }

    res.json({
      success: true,
      message: 'File updated successfully'
    });
  } catch (error) {
    console.error('Error updating file:', error);
    res.status(500).json({ success: false, error: 'Failed to update file' });
  }
});

// GET /api/notes/:filename - Get notes for a saved CSV file
app.get('/api/notes/:filename', async (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    const filePath = path.join(SAVED_CSV_DIR, filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const metadata = await readMetadata();
    const notes = metadata[filename]?.notes || '';

    res.json({
      success: true,
      notes: notes
    });
  } catch (error) {
    console.error('Error getting notes:', error);
    res.status(500).json({ success: false, error: 'Failed to get notes' });
  }
});

// PUT /api/notes/:filename - Update notes for a saved CSV file
app.put('/api/notes/:filename', async (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    const filePath = path.join(SAVED_CSV_DIR, filename);
    const notes = req.body.notes;

    if (notes === undefined) {
      return res.status(400).json({ success: false, error: 'No notes provided' });
    }

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Update metadata with notes
    const metadata = await readMetadata();
    if (metadata[filename]) {
      metadata[filename].notes = notes;
      await writeMetadata(metadata);
    }

    res.json({
      success: true,
      message: 'Notes updated successfully'
    });
  } catch (error) {
    console.error('Error updating notes:', error);
    res.status(500).json({ success: false, error: 'Failed to update notes' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`CSV/TSV Viewer server is running on http://localhost:${PORT}`);

  // Sync metadata with actual files on disk
  await syncMetadataWithFiles();
});
