const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// 上传配置
const upload = multer({
  dest: path.join(__dirname, '../uploads/audio'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadDir = path.join(__dirname, '../uploads/audio');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 页面（权限在 server.js 控制）
router.get('/audio-converter', (req, res) => {
  res.render('audio-converter');
});

// 转换接口
router.post('/api/audio/convert', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.json({ success: false, error: 'No file uploaded' });
  }

  const inputPath = req.file.path;
  const originalName = path.parse(req.file.originalname).name;
  const format = req.body.format || 'mp3';
  const outputName = `${originalName}.${format}`;
  const outputPath = path.join(uploadDir, outputName);

  const cmd = `ffmpeg -y -i "${inputPath}" "${outputPath}"`;

  exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
    fs.unlink(inputPath, () => {});

    if (error) {
      console.error('FFmpeg error:', stderr || error);
      return res.json({ success: false, error: 'Conversion failed' });
    }

    res.json({
      success: true,
      downloadUrl: `/uploads/audio/${outputName}`
    });
  });
});

module.exports = router;
