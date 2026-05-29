/**
 * QCDegens Scraper Server
 * Runs on Render.com free tier with Playwright
 * 
 * Endpoints:
 *   GET /health          — health check (keeps server awake)
 *   GET /scrape          — scrape PokerNews + 25KFantasy, returns JSON
 */

import express from 'express'
import { chromium } from 'playwright'

const app  = express()
const PORT = process.env.PORT || 3000

const PN_BASE     = 'https://www.pokernews.com/tours/wsop/2026-wsop'
const FANTASY_URL = 'https://www.25kfantasy.com/players/'

const PLAYERS = [
  { name: 'Daniel Negreanu',  slug: 'daniel-negreanu',  isBonus: false, altNames: [] },
  { name: 'Calvin Anderson',  slug: 'calvin-anderson',  isBonus: false, altNames: [] },
  { name: 'Yuval Bronshtein', slug: 'yuval-bronshtein', isBonus: false, altNames: [] },
  { name: 'Matt Glantz',      slug: 'matt-glantz',      isBonus: false, altNames: ['matthew glantz'] },
  { name: 'Ben Lamb',         slug: 'ben-lamb',         isBonus: false, altNames: [] },
  { name: 'Shawn Buchanan',   slug: 'shawn-buchanan',   isBonus: false, altNames: [] },
  { name: 'Ryan Leng',        slug: 'ryan-leng',        isBonus: false, altNames: [] },
  { name: 'John Riordan',     slug: 'john-riordan',     isBonus: false, altNames: [] },
  { name: 'Andrew Yeh',       slug: 'andrew-yeh',       isBonus: true,  altNames: [] },
]

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Player matching ───────────────────────────────────────────────────────────
function findPlayer(players, playerName, altNames = []) {
  if (!players?.length) return null
  const allNames = [playerName, ...altNames].map(n => n.toLowerCase())
  return players.find(p => {
    const pLower = p.name.toLowerCase().trim()
    return allNames.some(name => {
      const parts = name.trim().split(/\s+/)
      const first = parts[0]
      const last  = parts[parts.length - 1]
      const lastRegex = new RegExp('\\b' + last + '\\b', 'i')
      return lastRegex.test(pLower) && (pLower.includes(first) || first.length <= 3)
    })
  }) || null
}

// ── Scrape 25KFantasy ─────────────────────────────────────────────────────────
async function scrape25K(page) {
  log('Fetching 25KFantasy...')
  await page.goto(FANTASY_URL, { waitUntil: 'networkidle', timeout: 20000 })
  const rows = await page.evaluate(() => {
    const result = []
    document.querySelectorAll('table tbody tr').forEach(tr => {
      const link = tr.querySelector('a[href*="player-profile"]')
      if (!link) return
      const href = link.getAttribute('href') || ''
      const slug = href.split('/player-profile/')[1]?.replace(/\//g,'') || ''
      const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
      if (cells.length < 5) return
      result.push({ slug, name: link.textContent.trim(), pts: parseFloat(cells[3])||0, salary: parseFloat(cells[4])||0, cashes: parseInt(cells[5])||0 })
    })
    return result
  })
  const scoreMap = {}, nameMap = {}
  rows.forEach(r => {
    scoreMap[r.slug] = r
    nameMap[r.name.toLowerCase().replace(/[^a-z]/g,'')] = r
  })
  log(`  Got ${rows.length} scores`)
  return { scoreMap, nameMap }
}

// ── Get active events ─────────────────────────────────────────────────────────
async function getActiveEvents(page) {
  log('Building event list...')

  // Known WSOP 2026 events — we add more as they appear
  // The scraper will probe each one and skip if no data
  const knownEvents = []
  for (let i = 1; i <= 100; i++) {
    knownEvents.push({ num: i })
  }

  // Try to get event slugs from the WSOP schedule page (faster than live-reporting)
  let eventSlugs = []
  try {
    await page.goto('https://www.pokernews.com/tours/wsop/2026-wsop/', {
      waitUntil: 'domcontentloaded', timeout: 15000
    })
    eventSlugs = await page.evaluate(() => {
      const seen = new Set(), result = []
      document.querySelectorAll('a[href*="/2026-wsop/event-"]').forEach(a => {
        const href = a.getAttribute('href') || ''
        const m = href.match(/\/2026-wsop\/(event-[\w-]+)\//)
        if (m && !seen.has(m[1])) {
          seen.add(m[1])
          result.push({ slug: m[1], name: a.textContent.trim() || m[1] })
        }
      })
      return result
    })
    log(`  Found ${eventSlugs.length} events from schedule page`)
  } catch(e) {
    log(`  Schedule page failed: ${e.message}`)
  }

  if (eventSlugs.length > 0) {
    return eventSlugs.map(e => ({ ...e, url: `${PN_BASE}/${e.slug}/chips.htm` }))
  }

  // Fallback: return empty, chips pages will be probed by slug pattern
  log('  Using empty event list — will rely on previous data')
  return []
}

// ── Scrape chips page ─────────────────────────────────────────────────────────
async function scrapeChipsPage(page, eventSlug, completedSlugs = new Set()) {
  if (completedSlugs.has(eventSlug)) return null
  const url = `${PN_BASE}/${eventSlug}/chips.htm`
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    try { await page.waitForSelector('table tbody tr', { timeout: 8000 }) } catch {}
    await page.waitForTimeout(2000)

    return await page.evaluate((url) => {
      const bodyText = document.body.innerText
      const titleText = document.title + ' ' + (document.querySelector('h1')?.textContent || '')
      const buyinM = titleText.replace(/,/g,'').match(/\$(\d+)/)
      const buyin  = buyinM ? parseFloat(buyinM[1]) : null
      const plM    = bodyText.match(/Players Left[^\d]{0,15}([\d,]+)/i)
      const playersLeft = plM ? parseInt(plM[1].replace(/,/g,'')) : null
      const entM   = bodyText.match(/Total Entries[^\d]{0,10}([\d,]+)/i) || bodyText.match(/Entries[^\d]{0,5}([\d,]+)/i)
      const totalEntries = entM ? parseInt(entM[1].replace(/,/g,'')) : null

      const players = []
      document.querySelectorAll('table tbody tr').forEach(tr => {
        const link = tr.querySelector('a')
        if (!link) return
        const name = link.textContent.trim()
        if (!name || name.length < 2 || name.length > 60) return
        const cells = [...tr.querySelectorAll('td')]
        let rank = null
        for (let i = 0; i < Math.min(3, cells.length); i++) {
          const n = parseInt(cells[i].textContent.replace(/[^\d]/g,''))
          if (!isNaN(n) && n > 0 && n < 10000 && cells[i].textContent.replace(/[^\d]/g,'').length <= 4) { rank = n; break }
        }
        const allNums = cells.flatMap(td => {
          const parts = []
          td.childNodes.forEach(n => parts.push(n.textContent || ''))
          const text = parts.join(' ').replace(/[\u2191\u2193+\n\r]/g,' ')
          const matches = text.match(/\d{1,3}(?:,\d{3})+|\d{5,}/g) || []
          return matches.map(m => parseInt(m.replace(/,/g,'')))
        }).filter(n => n >= 5000 && n <= 9999999)
        if (!allNums.length) return
        players.push({ name, rank, chips: Math.max(...allNums) })
      })
      return { url, buyin, playersLeft, totalEntries, players }
    }, url)
  } catch(e) {
    log(`  Warning: ${eventSlug}: ${e.message}`)
    return null
  }
}

// ── Main scrape function ──────────────────────────────────────────────────────
async function doScrape(completedEvents = [], knownSlugs = []) {
  const completedSlugs = new Set(completedEvents)
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  })
  const page = await context.newPage()

  try {
    const { scoreMap, nameMap } = await scrape25K(page)
    let events = await getActiveEvents(page)

    // Fallback: use known slugs from previous data if discovery failed
    if (events.length === 0 && knownSlugs.length > 0) {
      log(`  Using ${knownSlugs.length} known slugs from previous data`)
      events = knownSlugs.map(slug => ({
        slug,
        name: slug,
        url: `${PN_BASE}/${slug}/chips.htm`
      }))
    }

    const eventsToCheck = events.slice(0, 15).filter(ev => !completedSlugs.has(ev.slug))

    const pagesData = {}
    for (const ev of eventsToCheck) {
      log(`  Checking ${ev.slug}...`)
      pagesData[ev.slug] = await scrapeChipsPage(page, ev.slug, completedSlugs)
      const pd = pagesData[ev.slug]
      if (pd) {
        log(`    → ${pd.players.length} players, ${pd.playersLeft ?? '?'} left`)
        PLAYERS.forEach(p => {
          const found = findPlayer(pd.players, p.name, p.altNames || [])
          if (found) log(`    ✓ FOUND ${p.name}: #${found.rank} (${found.chips?.toLocaleString()})`)
        })
      }
      await sleep(600)
    }

    // Build player data
    const newlyCompleted = []
    const players = PLAYERS.map(player => {
      const normName = player.name.toLowerCase().replace(/[^a-z]/g,'')
      const lastName = player.name.split(' ').slice(-1)[0].toLowerCase()
      const score = scoreMap[player.slug]
                 || nameMap[normName]
                 || nameMap[Object.keys(nameMap).find(k => k.includes(lastName)) || '']
                 || (player.isBonus ? { pts: 0, salary: 0, cashes: 0 } : null)

      const eventHistory = []
      let liveStatus = null

      for (const ev of eventsToCheck) {
        const pd = pagesData[ev.slug]
        if (!pd) continue
        const found = findPlayer(pd.players, player.name, player.altNames || [])
        if (!found) continue
        const entry = {
          eventSlug: ev.slug, eventName: ev.name || ev.slug,
          eventUrl: ev.url, buyin: pd.buyin,
          totalEntries: pd.totalEntries, playersLeft: pd.playersLeft,
          status: 'active', rank: found.rank, chips: found.chips,
          updatedAt: new Date().toISOString(),
        }
        eventHistory.push(entry)
        if (!liveStatus) liveStatus = entry
      }

      return {
        name: player.name, slug: player.slug, isBonus: player.isBonus,
        pts2026: score?.pts ?? 0, salary: score?.salary ?? null,
        cashes2026: score?.cashes ?? 0, liveStatus, eventHistory,
      }
    })

    // Detect completed events
    for (const ev of eventsToCheck) {
      const pd = pagesData[ev.slug]
      if (pd?.playersLeft != null && pd.playersLeft <= 1 && !completedSlugs.has(ev.slug)) {
        completedSlugs.add(ev.slug)
        newlyCompleted.push(ev.slug)
        log(`  ✓ Completed: ${ev.slug}`)
      }
    }

    return {
      updatedAt: new Date().toISOString(),
      teamScore: players.reduce((s, p) => s + (p.pts2026 || 0), 0),
      completedEvents: [...new Set([...completedEvents, ...newlyCompleted])],
      players,
      activeEvents: eventsToCheck.map(e => ({
        slug: e.slug, name: e.name, url: e.url,
        playersLeft: pagesData[e.slug]?.playersLeft,
        totalEntries: pagesData[e.slug]?.totalEntries,
        buyin: pagesData[e.slug]?.buyin,
        completed: completedSlugs.has(e.slug),
      })),
    }
  } finally {
    await browser.close()
  }
}

// ── Express routes ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

let scrapeInProgress = false
let lastResult = null

app.get('/scrape', async (req, res) => {
  const completedEvents = req.query.completed ? req.query.completed.split(',') : []

  // If result is fresh (< 4 min) return it immediately
  if (lastResult && (Date.now() - new Date(lastResult.updatedAt).getTime()) < 240000) {
    log('Returning cached result')
    return res.json({ status: 'ok', data: lastResult, cached: true })
  }

  // If scrape already in progress, wait for it
  if (scrapeInProgress) {
    log('Scrape in progress, waiting...')
    // Poll until done (max 4 min)
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 5000))
      if (!scrapeInProgress && lastResult) {
        return res.json({ status: 'ok', data: lastResult })
      }
    }
    return res.status(503).json({ status: 'timeout', message: 'Scrape taking too long' })
  }

  // Start scrape
  scrapeInProgress = true
  log('Starting scrape...')

  try {
    const completedEvents = req.query.completed ? req.query.completed.split(',') : []
    const knownSlugs = req.query.known ? req.query.known.split(',') : []
    const result = await doScrape(completedEvents, knownSlugs)
    lastResult = result
    res.json({ status: 'ok', data: result })
    log(`Scrape complete. Team score: ${result.teamScore}`)
  } catch(e) {
    log(`Scrape error: ${e.message}`)
    res.status(500).json({ status: 'error', message: e.message })
  } finally {
    scrapeInProgress = false
  }
})

app.listen(PORT, () => {
  log(`QCDegens scraper server running on port ${PORT}`)
})
