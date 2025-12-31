const express = require('express');
const puppeteer = require('puppeteer');
const sgMail = require('@sendgrid/mail');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const CRAIGSLIST_URLS = [
  'https://newyork.craigslist.org/search/tlg',
  'https://newyork.craigslist.org/search/brk/tlg',
  'https://newyork.craigslist.org/search/que/tlg',
  'https://newyork.craigslist.org/search/brx/tlg',
];

function extractEmails(text) {
  const patterns = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Z|a-z]{2,}\b/g,
    /\b[A-Za-z0-9._%+-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9.-]+\s*\[\s*dot\s*\]\s*[A-Z|a-z]{2,}\b/gi,
    /\b[A-Za-z0-9._%+-]+\s*\(\s*at\s*\)\s*[A-Za-z0-9.-]+\s*\(\s*dot\s*\)\s*[A-Z|a-z]{2,}\b/gi,
  ];
  
  const emails = new Set();
  for (const pattern of patterns) {
    const matches = Array.from(text.matchAll(pattern));
    for (const match of matches) {
      let email = match[0]
        .replace(/\s+/g, '')
        .replace(/\[at\]/gi, '@')
        .replace(/\[dot\]/gi, '.')
        .replace(/\(at\)/gi, '@')
        .replace(/\(dot\)/gi, '.');
      emails.add(email.toLowerCase());
    }
  }
  return Array.from(emails);
}

async function scrapeCraigslist() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const allCastings = [];
  
  try {
    for (const url of CRAIGSLIST_URLS) {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
      
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const listings = await page.$$eval('.result-row', (rows) => {
          return rows.slice(0, 10).map(row => {
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
          if (!listing.url) continue;
          
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
                source: 'craigslist',
                rate: compensation,
                date: listing.postedDate,
                type: ['modeling', 'acting']
              });
            }
            
            await detailPage.close();
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            console.error('Listing error:', error);
          }
        }
        
        await page.close();
      } catch (error) {
        console.error('Borough scrape error:', error);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  
  return allCastings;
}

app.get('/', (req, res) => {
  res.json({ status: 'Aigency Scraper API is running' });
});

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Scraper API running on port ${PORT}`);
});
