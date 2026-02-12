const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' })); // Increase body size limit for large CSV files

// Paths and limits
const SAVED_CSV_DIR = path.join(__dirname, 'saved_csvs');
const METADATA_FILE = path.join(SAVED_CSV_DIR, 'metadata.json');
const METADATA_FILENAME = path.basename(METADATA_FILE);
const ALLOWED_FILE_EXTENSIONS = ['.csv', '.tsv', '.txt'];
const MAX_SEARCH_MATCHES = 1000;

// Storage configuration for multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(SAVED_CSV_DIR, { recursive: true });
      cb(null, SAVED_CSV_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const resolved = resolveSavedFile(file.originalname);
    if (!resolved) {
      const error = new Error('Invalid filename');
      error.status = 400;
      error.code = 'INVALID_FILENAME';
      cb(error);
      return;
    }
    cb(null, resolved.filename);
  }
});

// File filter to only allow CSV, TSV, and TXT files
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_FILE_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    const error = new Error('Only CSV, TSV, and TXT files are allowed');
    error.status = 400;
    error.code = 'INVALID_FILE_TYPE';
    cb(error);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to read metadata
async function readMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Metadata read failed, using empty metadata object:', error.message);
    }
    return {};
  }
}

// Helper function to write metadata
async function writeMetadata(metadata) {
  const tempFile = `${METADATA_FILE}.tmp`;
  await fs.mkdir(SAVED_CSV_DIR, { recursive: true });

  try {
    await fs.writeFile(tempFile, JSON.stringify(metadata, null, 2), 'utf8');
    await fs.rename(tempFile, METADATA_FILE);
  } catch (error) {
    try {
      await fs.unlink(tempFile);
    } catch {
      // Ignore cleanup errors from best-effort temp file removal.
    }
    throw error;
  }
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return String(filename || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveSavedFile(filename) {
  const sanitizedFilename = sanitizeFilename(filename);
  if (
    !sanitizedFilename ||
    sanitizedFilename === '.' ||
    sanitizedFilename === '..' ||
    sanitizedFilename === METADATA_FILENAME
  ) {
    return null;
  }

  const filePath = path.resolve(SAVED_CSV_DIR, sanitizedFilename);
  const relativePath = path.relative(path.resolve(SAVED_CSV_DIR), filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return { filename: sanitizedFilename, filePath: filePath };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requireExistingSavedFile(res, filename) {
  const target = resolveSavedFile(filename);
  if (!target) {
    res.status(400).json({ success: false, error: 'Invalid filename' });
    return null;
  }

  if (!(await fileExists(target.filePath))) {
    res.status(404).json({ success: false, error: 'File not found' });
    return null;
  }

  return target;
}

function createDefaultMetadataEntry(filename, timestamp = new Date().toISOString()) {
  return {
    originalName: filename,
    savedName: filename,
    uploadedAt: timestamp,
    lastModified: timestamp,
    size: 0
  };
}

async function mutateMetadata(mutator) {
  const metadata = await readMetadata();
  const changed = await mutator(metadata);

  if (changed) {
    await writeMetadata(metadata);
  }

  return metadata;
}

async function getExistingMetadataEntries(metadata) {
  const entries = [];

  for (const [filename, info] of Object.entries(metadata)) {
    if (filename === METADATA_FILENAME) continue;

    const target = resolveSavedFile(filename);
    if (!target) {
      console.warn(`Skipping invalid filename in metadata: ${filename}`);
      continue;
    }

    if (!(await fileExists(target.filePath))) {
      console.warn(`Skipping missing file in metadata: ${filename}`);
      continue;
    }

    entries.push({
      filename: target.filename,
      filePath: target.filePath,
      info: info
    });
  }

  return entries;
}

function countQueryMatches(content, query) {
  if (!content || !query) return 0;
  let count = 0;
  let index = 0;

  while ((index = content.indexOf(query, index)) !== -1) {
    count += 1;
    if (count >= MAX_SEARCH_MATCHES) break;
    index += query.length || 1;
  }

  return count;
}

// Helper function to sync metadata with actual files on disk
async function syncMetadataWithFiles() {
  try {
    const metadata = await readMetadata();
    await fs.mkdir(SAVED_CSV_DIR, { recursive: true });
    const files = new Set(await fs.readdir(SAVED_CSV_DIR));

    // Remove metadata entries for files that don't exist
    let changed = false;
    for (const filename of Object.keys(metadata)) {
      if (filename === METADATA_FILENAME) {
        delete metadata[filename];
        changed = true;
        console.log(`Removed reserved metadata entry: ${filename}`);
        continue;
      }

      const target = resolveSavedFile(filename);
      if (!target || !files.has(target.filename)) {
        delete metadata[filename];
        changed = true;
        console.log(`Removed invalid/orphaned metadata entry: ${filename}`);
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
    const metadataEntries = await getExistingMetadataEntries(metadata);
    const fileList = metadataEntries.map(({ filename, info }) => ({
      filename: filename,
      ...info
    }));

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
    const metadataEntries = await getExistingMetadataEntries(metadata);
    const normalizedQuery = query.toLowerCase();
    const results = [];

    for (const { filename, filePath, info } of metadataEntries) {
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

    const filename = req.file.filename;
    const now = new Date().toISOString();

    await mutateMetadata((metadata) => {
      if (metadata[filename]) {
        metadata[filename].lastModified = now;
        metadata[filename].size = req.file.size;
      } else {
        metadata[filename] = {
          originalName: req.file.originalname,
          savedName: filename,
          uploadedAt: now,
          lastModified: now,
          size: req.file.size
        };
      }
      return true;
    });

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
    const target = await requireExistingSavedFile(res, req.params.filename);
    if (!target) return;

    // Send file
    res.sendFile(target.filePath);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ success: false, error: 'Failed to download file' });
  }
});

// PUT /api/rename/:filename - Rename a saved CSV file
app.put('/api/rename/:filename', async (req, res) => {
  try {
    const newFilenameInput = String(req.body.newFilename || '').trim();
    if (!newFilenameInput) {
      return res.status(400).json({ success: false, error: 'New filename is required' });
    }

    const oldTarget = await requireExistingSavedFile(res, req.params.filename);
    if (!oldTarget) return;

    const newTarget = resolveSavedFile(newFilenameInput);
    if (!newTarget) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const oldFilename = oldTarget.filename;
    const newFilename = newTarget.filename;

    if (await fileExists(newTarget.filePath)) {
      return res.status(400).json({ success: false, error: 'A file with that name already exists' });
    }

    const now = new Date().toISOString();

    // Rename file
    await fs.rename(oldTarget.filePath, newTarget.filePath);

    // Update metadata
    await mutateMetadata((metadata) => {
      const sourceMetadata = metadata[oldFilename] || createDefaultMetadataEntry(oldFilename, now);
      metadata[newFilename] = {
        ...sourceMetadata,
        savedName: newFilename,
        lastModified: now
      };
      delete metadata[oldFilename];
      return true;
    });

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
    const target = await requireExistingSavedFile(res, req.params.filename);
    if (!target) return;

    // Delete file
    await fs.unlink(target.filePath);

    // Update metadata
    await mutateMetadata((metadata) => {
      if (!metadata[target.filename]) return false;
      delete metadata[target.filename];
      return true;
    });

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
    const csvContent = req.body.content;

    if (typeof csvContent !== 'string') {
      return res.status(400).json({ success: false, error: 'No content provided' });
    }

    const target = await requireExistingSavedFile(res, req.params.filename);
    if (!target) return;

    // Write new content to file
    await fs.writeFile(target.filePath, csvContent, 'utf8');

    // Update metadata
    const now = new Date().toISOString();
    await mutateMetadata((metadata) => {
      const existingMetadata = metadata[target.filename] || createDefaultMetadataEntry(target.filename, now);
      metadata[target.filename] = {
        ...existingMetadata,
        savedName: target.filename,
        lastModified: now,
        size: Buffer.byteLength(csvContent, 'utf8')
      };
      return true;
    });

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
    const target = await requireExistingSavedFile(res, req.params.filename);
    if (!target) return;

    const metadata = await readMetadata();
    const notes = metadata[target.filename]?.notes || '';

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
    const notes = req.body.notes;

    if (notes === undefined) {
      return res.status(400).json({ success: false, error: 'No notes provided' });
    }

    const target = await requireExistingSavedFile(res, req.params.filename);
    if (!target) return;

    // Update metadata with notes
    const now = new Date().toISOString();
    await mutateMetadata((metadata) => {
      const existingMetadata = metadata[target.filename] || createDefaultMetadataEntry(target.filename, now);
      metadata[target.filename] = {
        ...existingMetadata,
        notes: notes
      };
      return true;
    });

    res.json({
      success: true,
      message: 'Notes updated successfully'
    });
  } catch (error) {
    console.error('Error updating notes:', error);
    res.status(500).json({ success: false, error: 'Failed to update notes' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }

  if (err && (err.code === 'INVALID_FILE_TYPE' || err.code === 'INVALID_FILENAME')) {
    return res.status(err.status || 400).json({ success: false, error: err.message });
  }

  if (req.path.startsWith('/api/')) {
    console.error('Unhandled API error:', err);
    return res.status(err?.status || 500).json({ success: false, error: 'Internal server error' });
  }

  return next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`CSV/TSV Viewer server is running on http://localhost:${PORT}`);

  // Sync metadata with actual files on disk
  await syncMetadataWithFiles();
});
