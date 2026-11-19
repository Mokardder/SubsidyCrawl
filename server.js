
const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ======================================================
// CONFIGURATION
// ======================================================

const PORT = process.env.PORT || 3000;

const API_TOKEN = process.env.API_TOKEN;

const APPSCRIPT_URL =
    process.env.APPSCRIPT_URL ||
    "https://script.google.com/macros/s/AKfycbx7exruxsEFMMyzA_Y-GjH7jQtkCUW6PdrOjxTVpRsxi6pP4Yfc8mz_JyArY4hs_vFH/exec";

const PORTAL_URL =
    "https://cx.indianoil.in/EPICIOCL/faces/GrievanceMainPage.jspx";

const MAX_ROWS = 5;

const jobs = new Map();

let activeJob = false;

// ======================================================
// AUTHENTICATION
// ======================================================

function authenticate(req, res, next) {
    const token = req.get("Authorization") || "";

    const expected = `Bearer ${API_TOKEN}`;

    const suppliedBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expected);

    if (
        !API_TOKEN ||
        suppliedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized",
            expected: API_TOKEN,
            entered: token
        });
    }

    next();
}

// ======================================================
// GOOGLE APPS SCRIPT
// ======================================================

async function fetchPendingSubsidies() {

    const response = await fetch(APPSCRIPT_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            type: "getPendingSubsidies"
        }),
        signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
        throw new Error(
            `Apps Script HTTP error: ${response.status}`
        );
    }

    const body = (await response.text()).trim();

    if (!body) {
        throw new Error("Apps Script returned empty response");
    }

    let root;

    try {
        root = JSON.parse(body);
    } catch {
        throw new Error(
            "Invalid Apps Script JSON: " + body.substring(0, 150)
        );
    }

    // Original Python base64 decoding behavior.
    if (root && root.data) {

        const decoded = Buffer.from(
            root.data,
            "base64"
        ).toString("utf8");

        return JSON.parse(decoded);
    }

    // Direct list/object response.
    if (Array.isArray(root)) {
        return root;
    }

    if (root && typeof root === "object") {
        return root;
    }

    throw new Error("Unexpected Apps Script response");
}


async function postSubsidyResults(results) {

    const response = await fetch(APPSCRIPT_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            type: "addSubsidyResults",
            results
        }),
        signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
        throw new Error(
            `Failed to upload results: HTTP ${response.status}`
        );
    }

    return await response.text();
}

// ======================================================
// UTILITY FUNCTIONS
// ======================================================

function addZeros(input) {

    const value = String(input);

    if (value.length >= 2) {
        return value.substring(0, 2) +
            "000000" +
            value.substring(2);
    }

    return value;
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function elementById(page, id) {

    // Safe for Oracle ADF IDs containing colons.
    return page.locator(`[id="${id}"]`);
}


// ======================================================
// SAFE CLICK
// ======================================================

async function safeClick(page, elementId, timeout = 20000) {

    const element = elementById(page, elementId);

    let lastError;

    for (let attempt = 0; attempt < 3; attempt++) {

        try {

            await element.waitFor({
                state: "visible",
                timeout
            });

            await element.scrollIntoViewIfNeeded();

            await element.click({
                timeout,
                force: false
            });

            return;

        } catch (error) {

            lastError = error;

            try {

                await element.evaluate(el => el.click());

                return;

            } catch (jsError) {

                lastError = jsError;

                await sleep(600);
            }
        }
    }

    throw new Error(
        `Failed to click ${elementId}: ${lastError.message}`
    );
}


// ======================================================
// NAVIGATION
// ======================================================

async function navigateToSubsidySearch(page) {

    await safeClick(page, "pt1:r1:0:cil2::icon");

    await sleep(400);

    await safeClick(page, "pt1:r1:0:i1:8:l1111::text");

    await sleep(400);

    await safeClick(page, "pt1:r1:0:i2:0:l1311::text");

    await sleep(400);
}


// ======================================================
// BROWSER INITIALIZATION
// ======================================================

async function initBrowser() {

    const browser = await chromium.launch({

        headless: true,

        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--no-first-run",
            "--disable-default-apps"
        ]
    });

    const context = await browser.newContext({

        viewport: {
            width: 1366,
            height: 768
        },

        acceptDownloads: false
    });

    const page = await context.newPage();

    page.setDefaultTimeout(60000);

    // Save bandwidth by blocking unnecessary resources.
    // Do not block JavaScript, CSS, XHR or fetch.
    await page.route("**/*", async route => {

        const type = route.request().resourceType();

        if (
            ["image", "font", "media"].includes(type)
        ) {
            return route.abort();
        }

        return route.continue();
    });

    await page.goto(PORTAL_URL, {

        waitUntil: "domcontentloaded",

        timeout: 60000
    });

    await navigateToSubsidySearch(page);

    return {
        browser,
        context,
        page
    };
}


// ======================================================
// TABLE EXTRACTION
// ======================================================

async function extractTableData(page) {

    const header = elementById(
        page,
        "pt1:r1:0:t1::ch::t"
    );

    const tbody = elementById(
        page,
        "pt1:r1:0:t1::db"
    );

    await header.waitFor({
        state: "attached",
        timeout: 30000
    });

    await tbody.waitFor({
        state: "attached",
        timeout: 30000
    });

    const result = await page.evaluate(
        ({ headerId, bodyId, maxRows }) => {

            const headerElement =
                document.getElementById(headerId);

            const bodyElement =
                document.getElementById(bodyId);

            if (!headerElement || !bodyElement) {
                throw new Error("ADF table elements not found");
            }

            const rawHeaders = Array.from(
                headerElement.querySelectorAll("th")
            ).map(th => th.innerText.trim());

            const headers = rawHeaders.filter(
                h => h && h.toUpperCase() !== "SELECT"
            );

            const rows = Array.from(
                bodyElement.querySelectorAll("tr")
            ).slice(0, maxRows);

            const data = rows.map(row => {

                const cells = Array.from(
                    row.querySelectorAll("td")
                ).map(cell => cell.innerText.trim());

                const rowObject = {};

                headers.forEach((header, index) => {

                    rowObject[header] = cells[index] || "";

                });

                return rowObject;
            });

            return data;
        },
        {
            headerId: "pt1:r1:0:t1::ch::t",
            bodyId: "pt1:r1:0:t1::db",
            maxRows: MAX_ROWS
        }
    );

    return JSON.stringify(result, null, 2);
}


// ======================================================
// SINGLE CONSUMER PROCESSING
// ======================================================

async function automateSingleRequest(
    page,
    consumerId,
    clickContinue = false
) {

    const result = {
        consumer_id: String(consumerId),
        success: false
    };

    try {

        if (clickContinue) {

            await safeClick(
                page,
                "pt1:r1:0:b2::text"
            );

            await sleep(500);

            await navigateToSubsidySearch(page);
        }

        // Same original consumer ID formatting.
        const consumerNo = addZeros(consumerId);

        const chunks = consumerNo.match(/.{1,4}/g) || [];

        if (chunks.length !== 4) {
            throw new Error(
                `Expected 4 consumer ID fields, received ${chunks.length}`
            );
        }

        // Fill the four consumer ID fields.
        for (let idx = 1; idx <= 4; idx++) {

            const field = elementById(
                page,
                `pt1:r1:0:it${idx}::content`
            );

            await field.waitFor({
                state: "visible",
                timeout: 10000
            });

            await field.fill(chunks[idx - 1]);
        }

        // Search.
        await safeClick(
            page,
            "pt1:r1:0:b11112"
        );

        // Extract table.
        const jsonResponse = await extractTableData(page);

        result.subsidy_b64 = Buffer.from(
            jsonResponse,
            "utf8"
        ).toString("base64");

        result.success = true;

        // Read customer name.
        const firstName = await elementById(
            page,
            "pt1:r1:0:it7::content"
        ).inputValue();

        const lastName = await elementById(
            page,
            "pt1:r1:0:it21::content"
        ).inputValue();

        result.user_name =
            `${firstName} ${lastName}`.trim();

    } catch (error) {

        result.error = error.message;
    }

    return result;
}


// ======================================================
// JOB PROCESSOR
// ======================================================

async function processJob(job) {

    let browser = null;

    const results = [];

    job.status = "running";
    job.startedAt = new Date().toISOString();

    let pendingData;

    try {

        // Fetch pending consumers.
        job.message = "Fetching pending subsidies";

        pendingData = await fetchPendingSubsidies();

        if (!Array.isArray(pendingData)) {
            throw new Error("Pending response is not an array");
        }

        job.total = pendingData.length;

        if (pendingData.length === 0) {
            job.message = "No pending records";
        } else {

            job.message = "Starting Chromium";

            const session = await initBrowser();

            browser = session.browser;

            const page = session.page;

            for (let idx = 0; idx < pendingData.length; idx++) {

                const item = pendingData[idx];

                const consumerId = String(item.user_id);

                job.current = idx + 1;

                job.message =
                    `Processing ${idx + 1}/${job.total}: ${consumerId}`;

                const result = await automateSingleRequest(
                    page,
                    consumerId,
                    idx > 0
                );

                if (result.success) {

                    results.push({

                        consumer_id: result.consumer_id,

                        user_name: result.user_name || "",

                        subsidy_b64: result.subsidy_b64

                    });

                    item.processed = true;

                    job.completed++;

                } else {

                    results.push({

                        consumer_id: consumerId,

                        user_name: item.user_name || "",

                        error: result.error || "Unknown error"

                    });

                    job.failed++;
                }

                job.results = results;

                // Small delay between requests.
                await sleep(300);
            }
        }

        // Close browser before uploading results.
        if (browser) {
            await browser.close();
            browser = null;
        }

        // Upload results to Apps Script.
        if (results.length > 0) {

            job.message = "Uploading results to Apps Script";

            await postSubsidyResults(results);

            job.uploaded = true;
        }

        job.status = "completed";

        job.message = "Processing completed";

    } catch (error) {

        job.status = "failed";

        job.error = error.message;

        job.message = "Job failed";

        console.error("Job error:", error);

    } finally {

        if (browser) {
            await browser.close().catch(() => {});
        }

        job.finishedAt = new Date().toISOString();

        activeJob = false;
    }
}


// ======================================================
// REST API
// ======================================================

app.get("/health", (req, res) => {

    res.json({

        success: true,

        service: "IndianOil Playwright Crawler",

        browser: "Chromium",

        running: activeJob

    });
});


// Create and start a background job.
app.post("/jobs", authenticate, async (req, res) => {

    if (activeJob) {

        return res.status(409).json({

            success: false,

            error: "Another job is already running"

        });
    }

    activeJob = true;

    const jobId = crypto.randomUUID();

    const job = {

        id: jobId,

        status: "queued",

        message: "Job created",

        total: 0,

        current: 0,

        completed: 0,

        failed: 0,

        uploaded: false,

        results: [],

        createdAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    // Start in background.
    setImmediate(() => {

        processJob(job).catch(error => {

            console.error(error);

            job.status = "failed";

            job.error = error.message;

            job.finishedAt = new Date().toISOString();

            activeJob = false;
        });

    });

    res.status(202).json({

        success: true,

        job_id: jobId,

        message: "Subsidy processing started",

        status_url: `/jobs/${jobId}`

    });
});


// Check job progress.
app.get("/jobs/:id", authenticate, (req, res) => {

    const job = jobs.get(req.params.id);

    if (!job) {

        return res.status(404).json({

            success: false,

            error: "Job not found"

        });
    }

    res.json(job);
});


// Temporary Chromium outbound IP diagnostic
app.get("/debug/egress", async (req, res) => {
    const expected = Buffer.from(`Bearer ${API_TOKEN}`);
    const actual = Buffer.from(req.headers.authorization || "");

    if (
        !API_TOKEN ||
        actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)
    ) {
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        });

        const page = await browser.newPage();

        await page.goto("https://ipapi.co/json/", {
            waitUntil: "domcontentloaded",
            timeout: 30000
        });

        const data = JSON.parse(
            await page.locator("body").innerText()
        );

        res.json({
            success: true,
            browser_ip: data.ip,
            country: data.country_name,
            country_code: data.country_code,
            region: data.region,
            city: data.city,
            organization: data.org
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });

    } finally {
        if (browser) {
            await browser.close();
        }
    }
});


// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `IndianOil Playwright API running on port ${PORT}`
    );

});
              
