// routes/legal.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const router = express.Router();

// 扫描可用地区
router.get('/lease/available', (req, res) => {
  const dir = path.join(__dirname, '../templates/lease');
  if (!fs.existsSync(dir)) return res.json({ countries: {} });

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const countries = {};

  files.forEach(file => {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const code = content.state || content.country || file.replace('.json', '').toUpperCase();
      const name = content.stateName || content.countryName || code;
      const countryKey = content.country || 'US';
      const countryName = content.countryName || (countryKey === 'US' ? 'United States' : countryKey);

      if (!countries[countryKey]) {
        countries[countryKey] = { name: countryName, regions: [] };
      }
      countries[countryKey].regions.push({ code, name, file });
    } catch (e) {}
  });

  res.json({ countries });
});

// 生成 PDF
router.post('/lease/generate', async (req, res) => {
  try {
    const { formData, template } = req.body;
    if (!formData || !template) return res.status(400).json({ error: 'Missing data' });

    const newPdf = await PDFDocument.create();
    const page = newPdf.addPage([612, 792]);
    const font = await newPdf.embedFont(StandardFonts.Helvetica);
    const { width, height } = page.getSize();

    let y = height - 50;
    const lineHeight = 14;

    function draw(text, size = 10, bold = false) {
      if (y < 40 || !text) return;
      page.drawText(String(text), { x: 50, y, size, font, color: rgb(0, 0, 0), maxWidth: width - 100 });
      y -= lineHeight * (bold ? 1.2 : 1);
    }

    const data = { ...formData };
    if (template.templateOverrides) Object.assign(data, template.templateOverrides);

    data.jurisdiction = data.jurisdiction || template.stateName || template.countryName || '';
    data.effectiveDate = data.effectiveDate || new Date().toLocaleDateString('en-US');
    data.additionalTerms = data.additionalTerms || 'None';

    // 条件披露处理
    if (template.conditionalDisclosures) {
      const cd = template.conditionalDisclosures;
      if (cd.floodDisclosure) {
        data.floodDisclosure = (data.inFloodZone === 'true' || data.inFloodZone === true)
          ? cd.floodDisclosure.ifTrue : cd.floodDisclosure.ifFalse;
      }
      if (cd.leadDisclosure) {
        data.leadDisclosure = (data.yearBuilt && parseInt(data.yearBuilt) < 1978)
          ? cd.leadDisclosure.ifBefore1978 : cd.leadDisclosure.ifAfter1978;
      }
    }

    if (data.stateDisclosures) {
      data.stateDisclosures = data.stateDisclosures
        .replace(/\{\{floodDisclosure\}\}/g, data.floodDisclosure || '')
        .replace(/\{\{leadDisclosure\}\}/g, data.leadDisclosure || '');
    }

    draw('RESIDENTIAL LEASE AGREEMENT', 14, true);
    y -= 6;
    draw(`Effective Date: ${data.effectiveDate}`);
    draw(`Governing Jurisdiction: ${data.jurisdiction}`);
    draw(`Rental Type: ${data.rentalType || 'Entire Premises'}`);
    y -= 8;

    draw('LANDLORD', 11, true);
    draw(`Name: ${data.landlordName || ''}`);
    draw(`Address: ${data.landlordAddress || ''}`);
    draw(`Phone / Email: ${data.landlordPhone || ''} | ${data.landlordEmail || ''}`);
    y -= 6;

    draw('TENANT', 11, true);
    draw(`Name: ${data.tenantName || ''}`);
    draw(`Address: ${data.tenantAddress || ''}`);
    draw(`Phone / Email: ${data.tenantPhone || ''} | ${data.tenantEmail || ''}`);
    y -= 10;

    draw('1. PREMISES', 11, true);
    draw(`Address: ${data.propertyAddress || ''}`);
    draw(`Description: ${data.premisesDescription || ''}`);
    draw(`Excluded: ${data.excludedAreas || ''}`);
    y -= 8;

    draw('2. TERM', 11, true);
    draw(`${data.startDate || ''}  to  ${data.endDate || ''}`);
    y -= 8;

    draw('3. RENT', 11, true);
    draw(`Monthly: $${data.rentAmount || ''}  |  Method: ${data.paymentMethod || ''}`);
    draw(`Late Fee: $${data.lateFee || ''}`);
    y -= 8;

    draw('4. SECURITY DEPOSIT', 11, true);
    draw(`Amount: $${data.depositAmount || ''}`);
    if (data.stateSecurityDepositClause) draw(data.stateSecurityDepositClause);
    y -= 8;

    draw('5. UTILITIES', 11, true);
    draw(`Tenant pays: ${data.tenantUtilities || ''}`);
    draw(`Landlord pays: ${data.landlordUtilities || ''}`);
    y -= 8;

    draw('6. OCCUPANCY', 11, true);
    draw(`Occupants: ${data.approvedOccupants || ''}`);
    draw(`Max: ${data.maxOccupants || ''}`);
    draw(`Smoking: ${data.smokingPolicy || ''}`);
    draw(`Parking: ${data.parkingDetails || ''}`);
    y -= 8;

    draw('7. PETS', 11, true);
    draw(data.petPolicy || '');
    y -= 8;

    draw('9. ENTRY', 11, true);
    draw(`Notice required: ${data.entryNoticeHours || '24'} hours`);
    y -= 8;

    draw('15. ADDITIONAL TERMS', 11, true);
    draw(data.additionalTerms || 'None');
    y -= 8;

    draw('16. DISCLOSURES', 11, true);
    if (data.stateDisclosures) draw(data.stateDisclosures);
    y -= 20;

    draw('IN WITNESS WHEREOF');
    y -= 25;
    draw('LANDLORD                          TENANT');
    y -= 18;
    draw('___________________________       ___________________________');
    draw(`Name: ${data.landlordName || ''}              Name: ${data.tenantName || ''}`);
    draw('Date: _______________             Date: _______________');

    y -= 40;
    draw('This is a template for informational purposes only and does not constitute legal advice.', 8);

    const pdfBytes = await newPdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Residential-Lease-Agreement.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
