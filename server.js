// Railway Scraper Service - server.js
// This runs on Railway and handles all Craigslist scraping

const express = require('express');
const puppeteer = require('puppeteer');
const sgMail = require('@sendgrid/mail');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const CRAIGSLIST_URLS = [
  'https://newyork.craigslist.org/search/tlg',
  'https://newyork.craigslist.org/search/brk/tlg',
  'https://newyork.craigslist.org/search/que/tlg',
  'https://newyork.craigslist.org/search/brx/tlg',
];

// Extract emails aggressively
function extractEmails(text) {
  const patterns = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/g,
    /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\[\s*dot\s*\]\s*[A-Z|a-z]{2,}\b/gi,
  ];
  
  const emails = new Set();
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      let email = match[0]
        .replace(/\s+/g, '')
        .replace(/\[at\]/gi, '@')
        .replace(/\[dot\]/gi, '.');
      emails.add(email.toLowerCase());
    }
  }
  return Array.from(emails);
}

// Send casting application email
async function sendApplication(casting, profile) {
  const emailBody = `
Dear Casting Director,

I am writing to express my interest in the casting opportunity: "${casting.title}".

CONTACT INFORMATION:
Name: ${profile.name}
Email: ${profile.email}
Phone: ${profile.phone}
Base Location: ${profile.base || 'NYC'}
Instagram: ${profile.instagram || 'N/A'}

MEASUREMENTS:
Height: ${profile.height}
Weight: ${profile.weight}
Bust/Chest: ${profile.bust}
Waist: ${profile.waist}
Inseam: ${profile.inseam}
Neck: ${profile.neck}
Sleeve: ${profile.sleeve}
Shoe Size: ${profile.shoeSize}

APPEARANCE:
Skin Color: ${profile.skinColor}
Hair Color: ${profile.hairColor}
Eye Color: ${profile.eyeColor}

I am professional, reliable, and available for work. Please contact me at ${profile.phone} or ${profile.email}.

Best regards,
${profile.name}
`.trim();

  try {
    await sgMail.send({
      to: casting.email,
      from: profile.email,
      replyTo: profile.email,
      subject: `Casting Application: ${casting.title} - ${profile.name}`,
      text: emailBody,
      html: emailBody.replace(/\n/g, '<br>')
    });
    return true;
  } catch (error) {
    console.error('Email error:', error);
    return false;
  }
}

// Scrape Craigslist
async function scrapeCraigslist() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });
  
  const allCastings = [];
  
  try {
    for (const url of CRAIGSLIST_URLS) {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      const listings = await page.$$eval('.result-row', (rows) => {
        return rows.slice(0, 15).map(row => {
          const link = row.querySelector('a');
          return {
            title: link?.textContent?.trim() || '',
            url: link?.getAttribute('href') || '',
            postedDate: row.querySelector('.result-date')?.getAttribute('datetime') || '',
            location: row.querySelector('.result-hood')?.textContent?.trim() || ''
          };
        });
      });
      
      for (const listing of listings) {
        try {
          const detailPage = await browser.newPage();
          await detailPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
          await detailPage.goto(listing.url, { waitUntil: 'networkidle2', timeout: 15000 });
          
          const content = await detailPage.$eval('#postingbody', el => el.textContent || '');
          const compensation = await detailPage.$eval('.attrgroup', el => {
            return el.textContent?.includes('compensation') ? el.textContent : 'Not specified';
          }).catch(() => 'Not specified');
          
          const emails = extractEmails(content);
          let finalEmail = emails[0] || null;
          
          // Check for Craigslist relay email
          if (!finalEmail) {
            const replyButton = await detailPage.$('a[href^="mailto:"]');
            if (replyButton) {
              const mailto = await replyButton.evaluate(el => el.getAttribute('href'));
              if (mailto) finalEmail = mailto.replace('mailto:', '').split('?')[0];
            }
          }
          
          if (finalEmail) {
            allCastings.push({
              id: listing.url.split('/').pop()?.split('.')[0] || `cl_${Date.now()}_${Math.random()}`,
              title: listing.title,
              description: content.substring(0, 500),
              url: listing.url,
              email: finalEmail,
              postedDate: listing.postedDate,
              location: listing.location,
              compensation,
              source: 'craigslist'
            });
          }
          
          await detailPage.close();
          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
        } catch (error) {
          console.error('Listing error:', error);
        }
      }
      
      await page.close();
    }
  } finally {
    await browser.close();
  }
  
  return allCastings;
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AIGENCY Scraper Service Running', timestamp: new Date().toISOString() });
});

// Get castings only (no application)
app.get('/scrape', async (req, res) => {
  try {
    const castings = await scrapeCraigslist();
    res.json({
      success: true,
      count: castings.length,
      castings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      castings: []
    });
  }
});

// Scrape AND auto-apply
app.post('/scrape-and-apply', async (req, res) => {
  try {
    const { profile, limit = 10 } = req.body;
    
    if (!profile || !profile.email) {
      return res.status(400).json({
        success: false,
        error: 'Profile with email required'
      });
    }
    
    const castings = await scrapeCraigslist();
    const toApply = castings.slice(0, Math.min(limit, castings.length));
    const results = [];
    
    for (const casting of toApply) {
      const sent = await sendApplication(casting, profile);
      results.push({
        castingId: casting.id,
        castingTitle: casting.title,
        castingUrl: casting.url,
        success: sent
      });
      
      // Delay between applications
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const successful = results.filter(r => r.success).length;
    
    res.json({
      success: true,
      applied: successful,
      failed: results.length - successful,
      results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 AIGENCY Scraper running on port ${PORT}`);
});
