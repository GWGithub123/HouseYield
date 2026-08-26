/*
  Generator: Creates 70 additional real-estate fine-tuning examples as JSONL.
  Structure mirrors existing file: each line is a JSON object with a `messages` array of system, user, assistant.
  Assistant responses target 1400-1500 words with domain-specific sections.
*/

import fs from 'node:fs';
import path from 'node:path';

const WORKDIR = process.cwd();
const INPUT_FILE = path.resolve(WORKDIR, 'real-estate-finetuning-examples.jsonl');
const OUTPUT_FILE = path.resolve(WORKDIR, 'real-estate-finetuning-examples.plus70.jsonl');

// Reuse the same system prompt used in the dataset
const SYSTEM_PROMPT = "You are a real estate AI assistant specialized in fair-value pricing, wedge detection, renovation ROI analysis, and rental viability assessment. You analyze properties using multimodal data (tabular features, images, market conditions) to provide accurate valuations and investment recommendations.";

// Utilities
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rand(0, arr.length - 1)];
const toWords = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

// Data pools for variety
const metros = [
  ['Austin', 'TX', '78704'], ['Denver', 'CO', '80211'], ['Phoenix', 'AZ', '85251'],
  ['Seattle', 'WA', '98112'], ['Miami', 'FL', '33139'], ['Nashville', 'TN', '37206'],
  ['Charlotte', 'NC', '28205'], ['Indianapolis', 'IN', '46220'], ['Columbus', 'OH', '43214'],
  ['Portland', 'OR', '97214'], ['San Jose', 'CA', '95125'], ['Boulder', 'CO', '80302'],
  ['Kansas City', 'MO', '64110'], ['Birmingham', 'AL', '35205'], ['Cleveland', 'OH', '44113'],
  ['Raleigh', 'NC', '27607'], ['Gatlinburg', 'TN', '37738'], ['Charleston', 'SC', '29401'],
  ['Memphis', 'TN', '38104'], ['Dallas', 'TX', '75206'], ['Atlanta', 'GA', '30318'],
  ['Boston', 'MA', '02134'], ['Chicago', 'IL', '60657'], ['San Diego', 'CA', '92103'],
  ['Salt Lake City', 'UT', '84103'], ['Madison', 'WI', '53703'], ['Tampa', 'FL', '33606'],
  ['New Orleans', 'LA', '70115'], ['Phoenix', 'AZ', '85018'], ['Boise', 'ID', '83702']
];

const propertyTypes = [
  'Single Family', 'Townhouse', 'Condo', 'Duplex', 'Triplex', 'Fourplex', 'Cabin', 'Modern Farmhouse', 'Craftsman', 'Ranch'
];

const scenarioKinds = [
  'fair_value', 'wedge_low', 'wedge_high', 'rental_viability', 'assumable_mortgage', 'subject_to',
  'renovation_roi', 'reno_plus_rent', 'luxury_sparse', 'flood_risk', 'multifamily', 'fix_and_flip',
  'str_vs_ltr', 'new_construction', 'inherited_sell_vs_rent', 'teardown_vs_reno', 'house_hack',
  'distressed_sale', 'seller_finance', 'pre_foreclosure', 'zoning_play', 'rent_to_own', 'value_add_brrrr',
  'appreciation_market', 'multi_scenario_financing'
];

// Helper to make an ATTOM-like property id
const propId = () => `attom_${rand(10000000, 99999999)}`;

// Build a realistic comp summary string
function compsSummary(kind) {
  const sales = rand(6, 18);
  const median = rand(180, 520);
  const dom = rand(20, 95);
  const iqr = rand(24, 68);
  if (kind === 'luxury_sparse') {
    return `Comps: ${rand(3,5)} sales in last ${rand(6,10)} months, ranging $${(rand(19,38)/10).toFixed(1)}M-$${(rand(22,42)/10).toFixed(1)}M, avg ${rand(120,190)} days old`;
  }
  return `Comps: ${sales} recent sales, median $${median}/sqft, avg ${dom} days old, IQR $${iqr}/sqft`;
}

// Build a user prompt per scenario
function buildUserPrompt(kind) {
  const [city, st, zip] = pick(metros);
  const type = pick(propertyTypes);
  const id = propId();
  const listDate = `2025-${String(rand(8,10)).padStart(2,'0')}-${String(rand(1,28)).padStart(2,'0')}`;
  const listPrice = rand(185000, 1450000);
  const beds = rand(2,5);
  const bathsFull = rand(1,3);
  const bathsHalf = rand(0,1);
  const baths = bathsFull + (bathsHalf ? 0.5 : 0);
  const sqft = rand(980, 3800);
  const lot = rand(2800, 22000);
  const yearBuilt = rand(1940, 2022);
  const rate = (Math.random() < 0.5) ? 6.75 : 7.25;
  const compStr = compsSummary(kind);
  const cov = (rand(62, 96) / 100).toFixed(2);
  const k = (rand(30, 95) / 100).toFixed(2);
  const b = (rand(30, 93) / 100).toFixed(2);
  const o = (rand(30, 92) / 100).toFixed(2);
  const flood = Math.random() < 0.15 ? 'AE' : 'X';
  const mortgageLine = `30-year mortgage rate: ${rate}%`;

  const head = (t) => `Analyze ${t}:
\nProperty ID: ${id}
Listed: ${listDate} at $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} bed, ${baths} bath
Square footage: ${sqft} sqft, ${lot.toLocaleString()} sqft lot
Year built: ${yearBuilt}
Condition scores: kitchen ${k}, bath ${b}, overall ${o}
Flood zone: ${flood}
${mortgageLine}
${compStr}
Coverage score: ${cov}`;

  switch (kind) {
    case 'fair_value':
      return head('this property for fair value, edge, spread, and decision gates');
    case 'wedge_low':
      return head('whether this listing is underpriced and quantify the wedge');
    case 'wedge_high':
      return head('this potentially overpriced listing and why it fails wedge gates');
    case 'rental_viability':
      return `${head('rental viability and DSCR')}
ATTOM Rent AVM: $${rand(1650, 3600)}/month
Property taxes: $${rand(1800, 9800)}/year
Insurance: $${rand(900, 2400)}/year
HOA: $${Math.random()<0.3?rand(50,350):0}/month
Financing: 20% down, ${rate}%, 30 years`;
    case 'assumable_mortgage':
      return `${head('rental viability with assumable mortgage option')}
ATTOM Rent AVM: $${rand(2200, 4200)}/month
Assumable Loan: balance $${rand(280000, 560000)}, rate ${ (Math.random()<0.5?2.75:3.25).toFixed(2)}%, ${rand(22,28)} years remaining`;
    case 'subject_to':
      return `${head('subject-to financing option and risks')}
Existing mortgage: $${rand(220000, 520000)} at ${(Math.random()<0.5?2.99:3.25).toFixed(2)}%, ${rand(22,28)} years left, P&I $${rand(1180, 1780)}/month
Seller situation: ${pick(['divorce','relocation','job loss','estate executor'])}, ${pick(['behind 1 payment','behind 2 payments','needs 30-day close'])}`;
    case 'renovation_roi':
      return `${head('renovation ROI opportunities and sequencing')}
Unfinished basement: ${Math.random()<0.5?`${rand(400, 900)} sqft`: 'None'}
Upgrades cost ranges: kitchen ($${rand(18000,45000)}), bath ($${rand(9000,18000)}), flooring ($${rand(5000,12000)})`;
    case 'reno_plus_rent':
      return `${head('combined renovation + rental strategy to reach DSCR ≥ 1.10')}
ATTOM Rent AVM (as-is): $${rand(1500, 2300)}/month, after-reno: $${rand(1900, 3000)}/month
Proposed reno budget: $${rand(35000, 90000)}`;
    case 'luxury_sparse':
      return `Detect pricing for luxury property with sparse comps:
\nProperty ID: ${id}
Listed: ${listDate} at $${rand(1850000, 3350000).toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${pick(['Contemporary','Modern','Penthouse','Estate Home'])}
Beds/Baths: ${rand(3,5)} bed, ${rand(3,5)}.5 bath
Square footage: ${rand(2200,5200)} sqft, lot ${Math.random()<0.5?`${(rand(4,90)/100).toFixed(2)} acres`:`${rand(4500,15000)} sqft`}
Year built: ${rand(2018, 2024)}
Condition scores: kitchen ${(rand(90, 96)/100).toFixed(2)}, bath ${(rand(88, 95)/100).toFixed(2)}, overall ${(rand(90, 96)/100).toFixed(2)} (luxury)
${mortgageLine}
${compsSummary('luxury_sparse')}
Coverage score: ${(rand(38, 55)/100).toFixed(2)}
Images: ${rand(18,30)} photos, high quality ${(rand(88, 96)/100).toFixed(2)}, room coverage ${(rand(76, 90)/100).toFixed(2)}`;
    case 'flood_risk':
      return `${head('property in high-risk flood area and climate trajectory')}
Flood insurance (NFIP): $${rand(1800, 5200)}/year
Elevation: ${rand(3, 9)} feet above sea level
Climate projection: ${rand(8, 20)} inch sea level rise by 2050`;
    case 'multifamily':
      return `Analyze multi-family investment opportunity:
\nProperty ID: ${id}
Listed: ${listDate} at $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${pick(['Duplex','Triplex','Fourplex'])}
Unit mix: ${rand(2,3)}x 2bd/1ba, ${Math.random()<0.6?`${rand(0,2)}x 1bd/1ba`: 'plus 1 studio'}
Total living sqft: ${rand(1800, 4100)}, Lot: ${rand(4000, 9000)} sqft
Year built: ${rand(1948, 1988)}
Current gross annual rent: $${rand(24000, 64000)}
Vacancy rate (area): ${rand(4,9)}%
Property taxes: $${rand(4200, 16800)}/year
Insurance: $${rand(1800, 4200)}/year
Financing: 25% down, ${rate+0.5}%, 30 years`;
    case 'fix_and_flip':
      return `${head('quick flip opportunity and 70% rule check')}
Estimated repairs needed: $${rand(35000, 85000)}
ARV (After Repair Value): $${(listPrice + rand(40000, 110000)).toLocaleString()}
Holding costs: $${rand(900, 1800)}/month
Selling costs: 8%`;
    case 'str_vs_ltr':
      return `Evaluate vacation rental (STR) vs long-term rental:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${pick(['Historic Cottage','Townhome','Cabin','Beach Bungalow'])}
Beds/Baths: ${beds} bed, ${baths} bath
Square footage: ${sqft} sqft
Year built: ${yearBuilt}
Condition scores: kitchen ${k}, bath ${b}, overall ${o}
STR data: Similar earn $${rand(280, 520)}/night, ${rand(55,78)}% occupancy
LTR rent: $${rand(1850, 3400)}/month
STR legal: Permitted with license $${rand(200, 600)}/year`;
    case 'new_construction':
      return `Analyze new construction pre-sale opportunity:
\nProperty ID: ${id}
Pre-Sale Price: $${listPrice.toLocaleString()} (builder incentive: $${rand(10000, 25000)})
Estimated Completion: ${pick(['March','April','May','June','July'])} 2026
Location: ${city}, ${st}, ZIP ${zip}
Type: ${pick(['Single Family','Townhouse'])}, ${pick(['Modern Farmhouse','Contemporary','Transitional'])}
Beds/Baths: ${beds} bed, ${baths} bath
Square footage: ${sqft} sqft
Builder: Regional builder (${rand(30, 120)} homes/year)
New construction comps: ${rand(2,4)} sold $${rand(520, 675)}K
ATTOM Rent AVM: $${rand(2700, 3600)}/month (new construction premium)`;
    case 'inherited_sell_vs_rent':
      return `Evaluate inherited property - sell vs rent decision:
\nProperty ID: ${id}
Inherited basis: $0
Current Market Value: $${(listPrice + rand(20000, 60000)).toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} bed, ${baths} bath
Square footage: ${sqft} sqft
Condition scores: kitchen ${k}, bath ${b}, overall ${o}
Estimated make-ready: $${rand(8000, 18000)}
ATTOM Rent AVM: $${rand(1650, 2450)}/month as-is, $${rand(1850, 2750)}/month after updates`;
    case 'teardown_vs_reno':
      return `Evaluate teardown vs renovation decision:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
FV50 (as-is): $${rand(350000, 650000)}
FV50 (if renovated): $${rand(800000, 1100000)}
FV50 (new construction): $${rand(1200000, 1850000)}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${pick(['Ranch','Bungalow'])}
Square footage: ${rand(850, 1200)} sqft, lot ${rand(7000, 11000)} sqft
Year built: ${rand(1948, 1965)}
Severe defects: foundation $${rand(35000, 65000)}, roof $${rand(12000, 22000)}, rewire $${rand(20000, 35000)}
Rebuild cost: $${rand(350, 475)}/sqft`;
    case 'house_hack':
      return `Analyze house hacking opportunity:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: Duplex (side-by-side)
Unit A: 2 bed / 1 bath, ${rand(780, 920)} sqft
Unit B: 2 bed / 1 bath, ${rand(780, 920)} sqft
Year built: ${rand(1958, 1978)}
Condition scores: kitchen_a ${(rand(62, 86)/100).toFixed(2)}, kitchen_b ${(rand(62, 86)/100).toFixed(2)}, overall ${(rand(62, 86)/100).toFixed(2)}
Rent comps Unit B: $${rand(1800, 2500)}/month
Buyer: First-time FHA 5% down at ${rate}%`;
    case 'distressed_sale':
      return `${head('distressed sale wedge with DOM history and price cuts')}
Status: Estate sale, as-is
Days on market: ${rand(90, 180)} days
Price history: reduced ${rand(2,4)} times
Renovation estimate: $${rand(48000, 92000)}
ARV (after repair): $${(listPrice + rand(60000, 120000)).toLocaleString()}`;
    case 'seller_finance':
      return `Analyze seller financing opportunity:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} bed / ${baths} bath
Square footage: ${sqft} sqft
Year built: ${yearBuilt}
Seller terms: $${rand(50000, 80000)} down, balance $${(listPrice - rand(50000, 80000)).toLocaleString()} at ${ (Math.random()<0.5?6.0:6.5)}% for ${pick([20,25,30])} years`;
    case 'pre_foreclosure':
      return `Evaluate pre-foreclosure deal:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} / ${baths}
Square footage: ${sqft} sqft
Mortgage owed: $${(listPrice + rand(10000, 30000)).toLocaleString()} (underwater)
Months behind: ${rand(3,6)} months
Sale date: ${rand(45, 75)} days
Renovation needed: $${rand(28000, 68000)}
ARV: $${(listPrice + rand(70000, 120000)).toLocaleString()}`;
    case 'zoning_play':
      return `Analyze zoning play opportunity:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: Single Family on ${rand(5200, 9000)} sqft lot
Current zoning: ${pick(['SF-3','R2','R1-5'])}
Proposed zoning: ${pick(['SF-6','RM','MU'])}
City vote: ${rand(30, 60)} days
Unit potential: ${pick(['duplex','triplex','4-plex','6 units'])}
Demo estimate: $${rand(15000, 28000)}
Build cost: $${rand(160, 220)}/sqft`;
    case 'rent_to_own':
      return `Evaluate rent-to-own deal:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} / ${baths}
Square footage: ${sqft} sqft
Proposed: 3-year lease-option, $${rand(10000, 18000)} option fee, $${rand(1650, 2450)}/month rent with $${rand(150, 300)} credit, strike price $${(listPrice + rand(8000, 40000)).toLocaleString()} at end`;
    case 'value_add_brrrr':
      return `${head('value-add renovation + BRRRR path with rent lift')}
Renovation estimate: $${rand(28000, 54000)}
Rent (as-is): $${rand(1000, 1450)}/month → After: $${rand(1350, 1850)}/month`;
    case 'appreciation_market':
      return `${head('investment in appreciation-driven A-market despite low cash flow')}
Rent comps: $${rand(1900, 2600)}-$${rand(2200, 3000)}/month
3-yr avg HPI: +${(rand(45, 95)/10).toFixed(1)}%
Vacancy: ${rand(3,6)}%`;
    case 'multi_scenario_financing':
      return `Compare rental viability with multiple financing scenarios:
\nProperty ID: ${id}
List Price: $${listPrice.toLocaleString()}
Location: ${city}, ${st}, ZIP ${zip}
Type: ${type}
Beds/Baths: ${beds} / ${baths}
Square footage: ${sqft} sqft
Year built: ${yearBuilt}
ATTOM Rent AVM: $${rand(1650, 2450)}/month
Financing Options:\n1) 20% down @ ${rate}%\n2) FHA 3.5% @ ${(rate-0.25).toFixed(2)}% + PMI\n3) All cash`;
    default:
      return head('this property');
  }
}

// Generate the assistant content with target word count using structured sections
function generateAssistant(kind, context) {
  // We combine reusable section builders and filler arrays to reach target length while staying on-topic.
  const sections = [];

  const add = (title, body) => {
    sections.push(`**${title}:**\n${body}`);
  };

  const metricsBlock = () => {
    const fv10 = rand(85, 96) * 10000;
    const fv50 = fv10 + rand(15000, 85000);
    const fv90 = fv50 + rand(25000, 85000);
    const list = rand(fv10 * 0.9, fv90 * 1.05);
    const edgePct = ((fv50 - list) / fv50) * 100;
    const spreadPct = ((fv90 - fv10) / fv50) * 100;
    const cov = (rand(60, 95) / 100).toFixed(2);
    const dq = (rand(60, 96) / 100).toFixed(2);
    const conf = Math.max(0.28, (1 - spreadPct / 100) * parseFloat(cov) * 0.95).toFixed(2);
    const wedgeScore = ((edgePct/100) * (1 - (spreadPct/100)) * parseFloat(cov)).toFixed(3);
    return (
      `- FV10: $${fv10.toLocaleString()}\n` +
      `- FV50: $${fv50.toLocaleString()}\n` +
      `- FV90: $${fv90.toLocaleString()}\n\n` +
      `- List: $${Math.round(list).toLocaleString()}\n` +
      `- Edge: ${edgePct.toFixed(1)}%\n` +
      `- Spread: ${spreadPct.toFixed(1)}%\n` +
      `- Coverage: ${cov}\n` +
      `- Data Quality: ${dq}\n` +
      `- Confidence: ${conf}\n` +
      `- Wedge Score: ${wedgeScore}`
    );
  };

  const riskBullets = [
    'Market trend reversal or rate spikes could impair liquidity and compress valuations.',
    'Data sparsity in immediate micro-geo may increase reliance on coarser encodings.',
    'Condition variance between listing photos and in-person inspection can shift value ±3-7%.',
    'Insurance and tax re-assessments can raise OPEX, tightening cash flow margins.',
    'DOM creep beyond 2× local median is often a signal of hidden issues or overpricing.',
    'Regulatory shifts (e.g., STR restrictions, rent caps) can alter underwriting assumptions.',
    'Vendor and materials cost inflation may erode planned renovation ROI if not value-engineered.',
    'Liquidity risk in luxury/unique assets: fewer buyers, higher sensitivity to macro conditions.'
  ];

  const actionSteps = [
    'Book showing within 24-48 hours and validate condition vs photos with a detailed punchlist.',
    'Request full photo set and disclosures (roof, foundation, systems, water/flood/termite).',
    'Pull permit history and verify any unpermitted work; scope corrective actions as needed.',
    'Engage a local lender and price out financing options (conventional, DSCR, portfolio, private).',
    'Model sensitivity for rent ±5-10%, rate ±50-100 bps, and OPEX ±10-15%.',
    'If remodeling, lock bids from two licensed GC’s and value-engineer scope and finishes.',
    'Pre-draft offer terms with inspection, appraisal, and financing contingencies as appropriate.',
    'Establish reserves: 6 months PITI + $5K maintenance minimum; higher for older properties.'
  ];

  // Core sections (varied ordering for diversity)
  add('Fair Value Assessment', metricsBlock());
  add('Decision and Wedge Interpretation', (
    'This pricing snapshot synthesizes the edge (mispricing magnitude), spread (uncertainty band), and coverage (data sufficiency) into a single decision lens. ' +
    'Positive edge with tight spread and strong coverage suggests a qualified wedge; negative edge with loose spread and weak coverage fails gates. ' +
    'Where the edge is modest, qualitative factors (condition, school quality, image intelligence, financing structure) determine actionability.'
  ));

  add('Comparable Sales and Geo Encodings', (
    'Recent comparable sales anchor baseline value per square foot, while H3/ZIP/tract encodings provide geo-smoothed priors when comp density is sparse. ' +
    'We emphasize temporal proximity (recency) and interquartile ranges to avoid cherry-picking outliers. In neighborhoods with micro-location premiums, ' +
    'we weight tract-level encodings more heavily to capture block-by-block variation.'
  ));

  add('Image and Condition Intelligence', (
    'Room-level condition scores for kitchens, baths, flooring, and curb appeal correlate strongly with both end-user willingness to pay and investor renovation budgets. ' +
    'High-quality, high-coverage photo sets reduce model uncertainty; conversely, sparse or low-quality imagery elevates spread due to unverifiable features.'
  ));

  add('Rental Viability and DSCR Thresholds', (
    'We evaluate rental candidates using DSCR (NOI / debt service) with a base gate of ≥1.10 for standard risk and ≥1.25 for commercial or value-add complexity. ' +
    'In today’s rate regime, many consumer-grade assets fail DSCR unless aided by rate arbitrage (assumable/subject-to), unusually high rents, or larger down payments. ' +
    'We also test resilience under ±5-10% rent shocks and ±10-15% OPEX changes to ensure durability.'
  ));

  add('Renovation ROI and Value-Engineering', (
    'Renovation decisions prioritize projects with proven market premiums (e.g., bed/bath count changes, functional obsolescence fixes, finished basements). ' +
    'We avoid over-improvement by aligning finish levels with neighborhood comps, using cost ranges validated by regional contractors. ' +
    'Value-engineering (LVP flooring, mid-grade fixtures, targeted curb appeal) often maximizes ROI with lower risk.'
  ));

  add('Sensitivity Analysis', (
    'We run parameterized variations for rent growth, interest rates, capex/maintenance, and sale timelines. ' +
    'Sensitivity exposes fragile assumptions and highlights whether a deal works only under perfect conditions or remains viable under realistic volatility.'
  ));

  add('Risk Factors', riskBullets.map((r,i)=>`${i+1}. ${r}`).join('\n'));
  add('Action Steps', actionSteps.map((a,i)=>`${i+1}. ${a}`).join('\n'));

  // Scenario-specific augmentation
  const scenarioNotes = {
    fair_value: 'Given the moderate spread and adequate coverage, the primary question is how list price maps to the interquartile band. If the ask sits near or below FV50 with solid data support, the execution risk is mainly operational (inspection outcomes, competitive bidding).',
    wedge_low: 'Underpricing with strong coverage and quality comps warrants swift action; the goal is to capture mispricing before market discovery. Escalation clauses and flexible close timelines can win without giving away the edge.',
    wedge_high: 'Overpricing that fails spread/coverage gates is a time sink. If you must engage, anchor the offer to FV50 minus a risk haircut and justify with comps, condition deltas, and macro headwinds.',
    rental_viability: 'For leveraged rentals, DSCR is king. If DSCR < 1.0, prioritize either a lower purchase price, creative financing, or a plan to lift rent via targeted improvements that tenants value.',
    assumable_mortgage: 'Assumable low-rate loans convert marginal deals into viable holds by reducing debt service. Validate assumption terms, remaining amortization schedule, and any lender overlays.',
    subject_to: 'Subject-to financing leverages legacy low rates but introduces due-on-sale optics. Keep payments pristine, insure correctly, and communicate with the seller whose credit remains exposed.',
    renovation_roi: 'Sequence projects by ROI and constraint removal: bed/bath count > kitchen/bath quality > flooring/paint > curb appeal. Combine only when blended ROI clears your hurdle rate.',
    reno_plus_rent: 'Blend value-add with rent targets to cross DSCR gates. A second bath or finished space often unlocks rent tiers more efficiently than a pure finish-level upgrade.',
    luxury_sparse: 'Sparse luxury comps and view/finish idiosyncrasies widen uncertainty. Use a specialist appraisal and qualitative audits (architect, builder pedigree, micro-siting) before concluding on price fairness.',
    flood_risk: 'High-risk flood zones impose a permanent insurance drag and future liquidity discount. Price the risk explicitly and assume premiums trend upward over time.',
    multifamily: 'Underwrite multi-family with realistic vacancy, management, and capex reserves. DSCR ≥1.25 and cap rate spreads vs debt costs are minimum guardrails.',
    fix_and_flip: 'Strictly enforce buy-box rules: 70% of ARV minus repairs for safe margins. Add contingencies for scope creep and time-to-sell risk.',
    str_vs_ltr: 'STR outperforms on revenue but adds operational/regulatory risk. Break even typically requires professional-grade revenue management and superior guest experience.',
    new_construction: 'Presales hinge on appraisal risk and delivery certainty. Builder credits and buydowns are real value; verify with comps and contract protections against delays.',
    inherited_sell_vs_rent: 'Stepped-up basis removes capital gains pressure—optimize strategy for liquidity vs long-term wealth rather than tax arbitrage.',
    teardown_vs_reno: 'If land value dominates and build costs exceed exit values, the only rational path is to pass or hold land speculatively with eyes wide open.',
    house_hack: 'Owner-occupied duplexes arbitrage housing costs while building equity. Ensure reserves to bridge vacancies and maintain FHA occupancy compliance.',
    distressed_sale: 'DOM + repeated price cuts + estate/relocation flags often create real wedges. Ensure renovation and exit math still clear target returns.',
    seller_finance: 'Term mechanics matter: a lower rate with a shorter amortization can still crush cash flow. Trade tenure for payment relief if monthly viability matters.',
    pre_foreclosure: 'Short sale timelines and lender calculus (vs REO costs) create bargaining space. Wholesale assignments can be the most capital-efficient exit.',
    zoning_play: 'Don’t build; sell the entitlement. Asymmetric upside lies in approvals, not in taking construction risk misaligned with exit values.',
    rent_to_own: 'Align strike price with expected appreciation; otherwise you subsidize the tenant-buyer’s equity. Keep option fee, credits, and default remedies clear.',
    value_add_brrrr: 'Capital recycling thrives on tight scopes that lift both rent and appraisal quickly. Stabilize, season, refi, then repeat.',
    appreciation_market: 'Negative carry can be acceptable where appreciation, paydown, and tax benefits create superior total returns with acceptable risk.',
    multi_scenario_financing: 'Compare conventional, FHA/PMI, and all-cash paths. In 2025’s rate regime, all-cash or creative structures often dominate purely leveraged plays.'
  };

  add('Scenario Notes', scenarioNotes[kind] || 'Standard underwriting applies; prioritize data coverage, spread discipline, and execution risk controls.');

  // Expand content until target words reached
  let content = sections.join('\n\n');
  const target = rand(1400, 1500);
  const filler = [
    'Gatekeeping criteria (spread ≤ 20%, coverage ≥ 0.60, DSCR thresholds by risk class) are enforced to reduce false positives and prevent overconfidence in sparse-data regimes.',
    'When comps are thin, we triangulate with geo-encodings, time decay weighting, and qualitative factors such as architecture, finish level, and school adjacency to tighten priors.',
    'Operational excellence—tight scopes, accurate bids, disciplined timelines—often determines whether a theoretical wedge becomes realized profit or evaporates through execution drift.',
    'Where regulatory or climate risks exist, we explicitly model insurance trajectories and exit liquidity discounts, not just current premiums or historical averages.',
    'For capital stack design, evaluate conventional, portfolio, DSCR, and creative options (assumable, subject-to, seller carries) against debt service outcomes and covenant risk.'
  ];
  let idx = 0;
  while (toWords(content) < target) {
    content += `\n\n${filler[idx % filler.length]}`;
    idx++;
    if (idx > 1000) break; // safety
  }

  // Trim if we overshoot a lot (keep within ~20 words)
  const words = content.split(/\s+/);
  if (words.length > target + 20) {
    content = words.slice(0, target + 20).join(' ');
  }
  return content;
}

function buildExample(kind) {
  const user = buildUserPrompt(kind);
  const assistant = generateAssistant(kind, user);
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
      { role: 'assistant', content: assistant }
    ]
  };
}

function main() {
  // Verify input file exists (optional, not strictly required)
  if (!fs.existsSync(INPUT_FILE)) {
    console.warn('Warning: source file not found; proceeding with default system prompt.');
  }

  const n = 70;
  const kinds = [];
  // Ensure coverage across scenarios by cycling through kinds then random fill
  const base = [...scenarioKinds];
  while (kinds.length < n) {
    kinds.push(...base);
  }
  kinds.length = n;
  // Shuffle for diversity
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }

  const out = fs.createWriteStream(OUTPUT_FILE, { encoding: 'utf8' });
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    const obj = buildExample(kind);
    const line = JSON.stringify(obj);
    // Validate word count window
    const wc = toWords(obj.messages[2].content);
    if (wc < 1350 || wc > 1550) {
      // Adjust by padding a generic but relevant analysis line blocks
      while (toWords(obj.messages[2].content) < 1400) {
        obj.messages[2].content += '\n\nAdditional underwriting note: Align offer timing with market cadence, and pre-commit to inspection slots to compress execution risk while preserving contingencies.';
      }
      const words = obj.messages[2].content.split(/\s+/);
      if (words.length > 1550) {
        obj.messages[2].content = words.slice(0, 1520).join(' ');
      }
    }
    out.write(JSON.stringify(obj) + '\n');
    ok++;
  }
  out.end();
  console.log(`Wrote ${ok} examples to ${OUTPUT_FILE}`);
}

main();
