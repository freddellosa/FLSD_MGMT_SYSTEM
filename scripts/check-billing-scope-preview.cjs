// Checks only the explicit private local scope-review artifact; no app/API/database access.
const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
(async () => {
  let browser;
  try {
    const root = path.resolve(__dirname, '..');
    if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
    const output = path.join(root, 'migration-input', 'review');
    const report = JSON.parse(fs.readFileSync(path.join(output, 'billing-scope-review.json'), 'utf8'));
    if (report.importEnabled !== false || report.review.importEnabled !== false || report.review.kind !== 'LEGACY_BILLING_SCOPE_REVIEW') throw new Error('Expected disabled offline review');
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (/^https?:/i.test(req.url())) remote.push(req.url()); });
    await page.goto(pathToFileURL(path.join(output, 'billing-scope-review.html')).href);
    await page.getByRole('heading', {name: 'Historical billing: service-period review', exact: true}).waitFor();
    const groups = await page.getByRole('table', {name: 'Scoped billing groups'}).locator('tbody tr').count();
    if (groups !== report.review.counts.groups) throw new Error('Scope table count mismatch');
    const coverage = await page.getByRole('region', {name: 'Service coverage'}).innerText();
    if (report.review.coverage.months.some(m => !coverage.includes(m.month + ': ' + m.suppliedTripRows + ' supplied trips')) ||
        !coverage.includes(report.review.coverage.includedTrips + ' included trips')) throw new Error('Actual source coverage mismatch');
    if (await page.locator('script,iframe,form').count()) throw new Error('Active content in report');
    await page.getByText('Show prior diagnostic locations', {exact: true}).click();
    const diagnosticRows = await page.locator('details').first().locator('tbody tr').count();
    if (diagnosticRows !== report.diagnostics.total) throw new Error('Prior diagnostic table mismatch');
    await page.screenshot({path: path.join(output, 'billing-scope-preview.png')});
    await page.setViewportSize({width: 390, height: 844});
    if (!await page.getByRole('table', {name: 'Scoped billing groups'}).isVisible()) throw new Error('Mobile evidence table missing');
    if (errors.length || remote.length) throw new Error('Report made remote requests or raised browser errors');
    let mappingProposalRows = null, customerTaskRows = null;
    const mappingPath = path.join(output, 'billing-mapping-proposals.generated.json');
    if (fs.existsSync(mappingPath)) {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      if (mapping.packet.importEnabled !== false || mapping.decisionSummary.executionAuthorized !== false) throw new Error('Mapping execution gate mismatch');
      await page.setViewportSize({width: 1440, height: 1000});
      await page.goto(pathToFileURL(path.join(output, 'billing-mapping-review.html')).href);
      await page.getByRole('heading', {name: 'Billing mapping proposals', exact: true}).waitFor();
      mappingProposalRows = await page.getByRole('table', {name: 'Billing mapping proposals'}).locator('tbody tr').count();
      customerTaskRows = await page.getByRole('table', {name: 'Source customer review coverage'}).locator('tbody tr').count();
      if (mappingProposalRows !== mapping.packet.counts.groups || customerTaskRows !== mapping.packet.counts.customerTasks) throw new Error('Mapping preview counts mismatch');
      const decisions = JSON.parse(fs.readFileSync(path.join(output, mapping.decisionFileName), 'utf8'));
      const recorded = page.getByRole('region', {name: 'Recorded review progress'});
      const progressText = await recorded.innerText();
      const pending = decisions.items.filter(d => d.decision === 'PENDING').length;
      const confirmed = decisions.items.filter(d => d.decision === 'CONFIRM_CANDIDATE_IDENTITY').length;
      if (!progressText.includes(pending + ' pending; ' + confirmed + ' identity confirmations')) throw new Error('Recorded decision progress mismatch');
      for (const decision of decisions.items) {
        const row = page.locator('[id="proposal-' + encodeURIComponent(decision.proposalId) + '"]');
        const text = await row.innerText();
        if (decision.reviewerNote && !text.includes(decision.reviewerNote)) throw new Error('Recorded review note missing');
        if (decision.decision === 'REJECT_CANDIDATE' && !text.includes('Candidate rejected; unresolved')) throw new Error('Rejected identity presented as resolved');
        if (decision.decision === 'CONFIRM_CANDIDATE_IDENTITY' && !text.includes('Identity confirmed')) throw new Error('Confirmed identity missing');
      }
      const outstanding = decisions.items.filter(d => d.decision !== 'CONFIRM_CANDIDATE_IDENTITY').length;
      if (await recorded.getByRole('link').count() !== outstanding) throw new Error('Outstanding relationship navigation mismatch');
      const firstLink = recorded.getByRole('link').first();
      if (outstanding) { const target = await firstLink.getAttribute('href'); await firstLink.click(); if (!target || !await page.locator('[id="' + target.slice(1) + '"]').isVisible()) throw new Error('Outstanding relationship target missing'); }
      if (await page.locator('script,iframe,form').count()) throw new Error('Active mapping preview content');
      const summary = await page.getByRole('region', {name: 'Proposal summary'}).innerText();
      if (!summary.includes(mapping.packet.counts.candidateIdentityConfirmations + ' identity-confirmation candidates') || !summary.includes('Existing decision and contract-template edits are preserved')) throw new Error('Mapping preview summary mismatch');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path: path.join(output, 'billing-mapping-preview.png')});
      await page.setViewportSize({width: 390, height: 844});
      if (!await page.getByRole('table', {name: 'Billing mapping proposals'}).isVisible()) throw new Error('Mobile mapping table missing');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile mapping page overflow');
    }
    let octoberTripRows = null;
    const octoberPath = path.join(output, 'october-trip-preflight.json');
    if (fs.existsSync(octoberPath)) {
      const october = JSON.parse(fs.readFileSync(octoberPath, 'utf8'));
      if (october.importEnabled !== false || october.kind !== 'OCTOBER_TRIP_SELECTED_CHECKS') throw new Error('October preflight gate mismatch');
      await page.setViewportSize({width: 1440, height: 1000});
      await page.goto(pathToFileURL(path.join(output, 'october-trip-preflight.html')).href);
      octoberTripRows = await page.getByRole('table', {name: 'October trip checks'}).locator('tbody tr').count();
      if (octoberTripRows !== october.report.rows.length || await page.locator('script,iframe,form').count()) throw new Error('October preflight table mismatch');
      const summary = await page.getByRole('region', {name: 'October selected checks'}).innerText();
      if (!summary.includes(october.zeroGrossRejectedRows + ' rejected rows have recorded zero gross')) throw new Error('Missing zero-charge distinction');
      await page.setViewportSize({width: 390, height: 844});
      if (!await page.getByRole('table', {name: 'October trip checks'}).isVisible()) throw new Error('Mobile October evidence missing');
    }
    if (errors.length || remote.length) throw new Error('Preview raised errors or remote requests');
    console.log(JSON.stringify({sourceGroupsVerified: groups, priorDiagnosticRowsVerified: diagnosticRows, mappingProposalRows, customerTaskRows, octoberTripRows, desktop: true, mobile: true, remoteRequests: 0, browserErrors: 0}));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Private preview check failed'); process.exitCode = 1; }
  finally { if (browser) await browser.close(); }
})();
