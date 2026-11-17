const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const multer = require('multer');

// 上传配置
const upload = multer({ dest: path.join(__dirname, '../uploads/temp') });

// 页面
router.get('/audio-converter', (req, res) => {
  res.render('audio-converter');
});

// 转换接口
router.post('/api/audio-convert', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.json({ success: false, error: 'No file uploaded' });
  }

  const inputPath = req.file.path;
  const format = req.body.format || 'mp3';
  const bitrate = req.body.bitrate || '192k';
  const outputDir = path.join(__dirname, '../uploads/converted');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputName = `${baseName}.${format}`;
  const outputPath = path.join(outputDir, outputName);

  let cmd = `ffmpeg -i "${inputPath}" -y`;
  if (['mp3', 'aac', 'ogg'].includes(format)) {
    cmd += ` -b:a ${bitrate}`;
  }
  cmd += ` "${outputPath}"`;

  exec(cmd, { timeout: 120000 }, (error) => {
    fs.unlink(inputPath, () => {});

    if (error) {
      console.error(error);
      return res.json({ success: false, error: 'Conversion failed' });
    }

    res.json({
      success: true,
      downloadUrl: `/download-converted/${outputName}`,
      filename: outputName
    });
  });
});

// 下载
router.get('/download-converted/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../uploads/converted', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});

module.exports = router;
