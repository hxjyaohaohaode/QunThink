import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../models/db.js';
import { parseFile } from '../services/fileParser/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const uploadDir = path.join(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({ storage });

router.post('/files/upload', upload.single('file'), async (req, res) => {
  const db = getDb();
  await db.read();
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { group_id, uploader_id } = req.body;

  const fileId = uuidv4();
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const fileSize = req.file.size;
  const mimeType = req.file.mimetype;

  let parsedContent = null;
  try {
    parsedContent = await parseFile(filePath, mimeType);
  } catch (error) {
    console.error('File parse error:', error);
  }

  const fileRecord = {
    id: fileId,
    group_id,
    uploader_id,
    filename: fileName,
    original_path: filePath,
    file_size: fileSize,
    mime_type: mimeType,
    parsed_content: parsedContent,
    created_at: new Date().toISOString()
  };

  db.data.files.push(fileRecord);
  await db.write();

  res.status(201).json(fileRecord);
});

router.get('/files/:id', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  
  const file = db.data.files.find(f => f.id === id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.json(file);
});

router.get('/files/:id/content', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  
  const file = db.data.files.find(f => f.id === id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.json({ content: file.parsed_content });
});

export default router;
