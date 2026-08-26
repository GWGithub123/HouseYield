// Municipality Building Permits API Integration
// Pulls building permit data directly from city/county open data portals
// Provides more comprehensive and up-to-date permit history than ATTOM

import 'dotenv/config';

/**
 * Fetch building permits from municipality open data APIs
 * @param {Object} params - { address, city, state, zip, latitude, longitude }
 * @returns {Promise<Array>} Array of permit objects
 */
export async function fetchMunicipalityPermits({ address, city, state, zip, latitude, longitude }) {
  const permits = [];
  
  // Determine which municipality API to use based on location
  const cityKey = city?.toLowerCase().replace(/\s+/g, '-');
  const stateCode = state?.toUpperCase();
  
  console.log(`[Municipality Permits] Searching for permits: ${address}, ${city}, ${state}`);
  
  try {
    // Route to appropriate municipality API
    if (cityKey === 'los-angeles' && stateCode === 'CA') {
      const laPermits = await fetchLosAngelesPermits({ address, latitude, longitude });
      permits.push(...laPermits);
    } else if (cityKey === 'san-francisco' && stateCode === 'CA') {
      const sfPermits = await fetchSanFranciscoPermits({ address, latitude, longitude });
      permits.push(...sfPermits);
    } else if (cityKey === 'new-york' && stateCode === 'NY') {
      const nycPermits = await fetchNewYorkPermits({ address, latitude, longitude });
      permits.push(...nycPermits);
    } else if (cityKey === 'chicago' && stateCode === 'IL') {
      const chiPermits = await fetchChicagoPermits({ address, latitude, longitude });
      permits.push(...chiPermits);
    } else if (cityKey === 'seattle' && stateCode === 'WA') {
      const seaPermits = await fetchSeattlePermits({ address, latitude, longitude });
      permits.push(...seaPermits);
    } else if (cityKey === 'austin' && stateCode === 'TX') {
      const ausPermits = await fetchAustinPermits({ address, latitude, longitude });
      permits.push(...ausPermits);
    } else if (stateCode === 'MD') {
      // Montgomery County, MD has excellent open data
      const mdPermits = await fetchMarylandPermits({ address, city, latitude, longitude });
      permits.push(...mdPermits);
    } else if (stateCode === 'DC') {
      const dcPermits = await fetchDCPermits({ address, latitude, longitude });
      permits.push(...dcPermits);
    }
    
    console.log(`[Municipality Permits] Found ${permits.length} permits from ${city || state}`);
    
    // Normalize and sort permits
    return permits.map(normalizePermit).filter(Boolean).sort((a, b) => {
      if (!a.issue_date) return 1;
      if (!b.issue_date) return -1;
      return b.issue_date.localeCompare(a.issue_date);
    });
    
  } catch (error) {
    console.error(`[Municipality Permits] Error fetching permits:`, error.message);
    return [];
  }
}

/**
 * Los Angeles Building Permits (LADBS Open Data)
 * API: https://data.lacity.org/resource/xnhu-aczu.json
 */
async function fetchLosAngelesPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.lacity.org/resource/xnhu-aczu.json';
    
    // Clean address for search
    const cleanAddress = address.split(',')[0].trim().toUpperCase();
    
    // Extract street name from full address (e.g., "1600 Vine St" -> "VINE")
    const parts = cleanAddress.split(' ');
    const streetName = parts.length > 2 ? parts.slice(1, -1).join(' ') : parts[1] || '';
    
    const params = new URLSearchParams({
      $where: `upper(street_name) like '%${streetName}%'`,
      $limit: 50,
      $order: 'issue_date DESC'
    });
    
    console.log('[LA Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[LA Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[LA Permits] Found', data.length, 'permits');
    
    // Filter by address number after fetching
    const addressNum = parts[0];
    const filtered = data.filter(permit => 
      permit.address_start === addressNum || 
      (permit.address_start <= addressNum && permit.address_end >= addressNum)
    );
    
    console.log('[LA Permits] After address filtering:', filtered.length, 'permits');
    
    return filtered.map(permit => ({
      source: 'Los Angeles LADBS',
      permit_number: permit.pcis_permit || permit.reference_old_permit,
      permit_type: permit.permit_type,
      permit_type_description: permit.permit_sub_type || permit.permit_category,
      issue_date: permit.issue_date,
      status: permit.latest_status,
      work_description: null,
      estimated_cost: null,
      contractor_name: null,
      address: `${permit.address_start} ${permit.street_direction || ''} ${permit.street_name} ${permit.street_suffix || ''}`.trim(),
      raw: permit
    }));
  } catch (error) {
    console.error('[LA Permits] Error:', error.message);
    return [];
  }
}

/**
 * San Francisco Building Permits
 * API: https://data.sfgov.org/resource/i98e-djp9.json
 */
async function fetchSanFranciscoPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.sfgov.org/resource/i98e-djp9.json';
    
    const cleanAddress = address.split(',')[0].trim();
    const streetParts = cleanAddress.split(' ');
    const streetName = streetParts.slice(1).join(' ').toUpperCase();
    
    const params = new URLSearchParams({
      $where: `upper(street_name) like '%${streetName}%'`,
      $limit: 50,
      $order: 'filed_date DESC'
    });
    
    console.log('[SF Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[SF Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[SF Permits] Found', data.length, 'permits');
    
    return data.map(permit => ({
      source: 'San Francisco DBI',
      permit_number: permit.permit_number,
      permit_type: permit.permit_type,
      permit_type_description: permit.description,
      issue_date: permit.issued_date || permit.filed_date,
      status: permit.status || permit.current_status,
      work_description: permit.proposed_use || permit.description,
      estimated_cost: parseFloat(permit.estimated_cost || permit.revised_cost) || null,
      contractor_name: null,
      address: `${permit.street_number} ${permit.street_name}, San Francisco, CA`,
      raw: permit
    }));
  } catch (error) {
    console.error('[SF Permits] Error:', error.message);
    return [];
  }
}

/**
 * New York City Building Permits (DOB)
 * API: https://data.cityofnewyork.us/resource/rbx6-tga4.json
 */
async function fetchNewYorkPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.cityofnewyork.us/resource/rbx6-tga4.json';
    
    const cleanAddress = address.split(',')[0].trim();
    const houseNumber = cleanAddress.split(' ')[0];
    
    const params = new URLSearchParams({
      $where: `house_no like '${houseNumber}%'`,
      $limit: 50,
      $order: 'issued_date DESC'
    });
    
    console.log('[NYC Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[NYC Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[NYC Permits] Found', data.length, 'permits');
    
    return data.map(permit => ({
      source: 'NYC DOB',
      permit_number: permit.job_filing_number || permit.work_permit,
      permit_type: permit.work_type,
      permit_type_description: permit.filing_reason,
      issue_date: permit.issued_date,
      status: permit.permit_status,
      work_description: permit.job_description,
      estimated_cost: parseFloat(permit.estimated_job_costs) || null,
      contractor_name: permit.applicant_business_name || `${permit.applicant_first_name || ''} ${permit.applicant_last_name || ''}`.trim(),
      address: `${permit.house_no} ${permit.street_name}, ${permit.borough}`,
      raw: permit
    }));
  } catch (error) {
    console.error('[NYC Permits] Error:', error.message);
    return [];
  }
}

/**
 * Chicago Building Permits
 * API: https://data.cityofchicago.org/resource/ydr8-5enu.json
 */
async function fetchChicagoPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.cityofchicago.org/resource/ydr8-5enu.json';
    
    const cleanAddress = address.split(',')[0].trim();
    const streetParts = cleanAddress.split(' ');
    const streetName = streetParts.slice(1).join(' ').toUpperCase();
    
    const params = new URLSearchParams({
      $where: `upper(street_name) like '%${streetName}%'`,
      $limit: 50,
      $order: 'issue_date DESC'
    });
    
    console.log('[Chicago Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[Chicago Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[Chicago Permits] Found', data.length, 'permits');
    
    return data.map(permit => ({
      source: 'Chicago DOB',
      permit_number: permit.permit_ || permit.id,
      permit_type: permit.permit_type,
      permit_type_description: permit.work_description,
      issue_date: permit.issue_date,
      status: permit.status || permit.permit_status,
      work_description: permit.work_description,
      estimated_cost: parseFloat(permit.reported_cost || permit.total_fee) || null,
      contractor_name: permit.contractor_name,
      address: permit.street_name ? `${permit.street_number} ${permit.street_name}, Chicago, IL` : null,
      raw: permit
    }));
  } catch (error) {
    console.error('[Chicago Permits] Error:', error.message);
    return [];
  }
}

/**
 * Seattle Building Permits
 * API: https://data.seattle.gov/resource/76t5-zqzr.json
 */
async function fetchSeattlePermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.seattle.gov/resource/76t5-zqzr.json';
    
    const cleanAddress = address.split(',')[0].trim().toUpperCase();
    
    const params = new URLSearchParams({
      $where: `upper(originaladdress1) like '%${cleanAddress}%'`,
      $limit: 50,
      $order: 'permitnum DESC'
    });
    
    console.log('[Seattle Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[Seattle Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[Seattle Permits] Found', data.length, 'permits');
    
    // Log detailed permit information
    if (data.length > 0) {
      console.log('\n========== SEATTLE PERMIT DETAILS ==========');
      data.forEach((permit, index) => {
        console.log(`\n--- Permit ${index + 1} ---`);
        console.log('Permit Number:', permit.permitnum);
        console.log('Permit Class:', permit.permitclass || permit.permitclassmapped);
        console.log('Permit Type:', permit.permittypedesc || permit.permittypemapped);
        console.log('Status:', permit.statuscurrent);
        console.log('Address:', permit.originaladdress1);
        console.log('Description:', permit.description);
        console.log('Application Date:', permit.applicationdate);
        console.log('Issue Date:', permit.issueddate);
        console.log('Final Date:', permit.finaldate);
        console.log('Expiration Date:', permit.expiresdate);
      });
      console.log('\n==========================================\n');
    }
    
    return data.map(permit => ({
      source: 'Seattle SDCI',
      permit_number: permit.permitnum,
      permit_type: permit.permitclass || permit.permitclassmapped,
      permit_type_description: permit.permittypedesc || permit.permittypemapped,
      issue_date: permit.issueddate || permit.applicationdate || permit.applieddate || null,
      status: permit.statuscurrent,
      work_description: permit.description,
      estimated_cost: parseFloat(permit.estprojectcost || permit.value) || null,
      contractor_name: permit.contractorcompanyname || null,
      address: permit.originaladdress1,
      raw: permit
    }));
  } catch (error) {
    console.error('[Seattle Permits] Error:', error.message);
    return [];
  }
}

/**
 * Austin Building Permits
 * API: https://data.austintexas.gov/resource/quv8-5ckq.json
 */
async function fetchAustinPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://data.austintexas.gov/resource/quv8-5ckq.json';
    
    const cleanAddress = address.split(',')[0].trim().toUpperCase();
    
    const params = new URLSearchParams({
      $where: `upper(permit_location) like '%${cleanAddress}%'`,
      $limit: 50,
      $order: 'issue_date DESC'
    });
    
    console.log('[Austin Permits] Fetching from:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    console.log('[Austin Permits] Response status:', response.status);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    console.log('[Austin Permits] Found', data.length, 'permits');
    
    return data.map(permit => ({
      source: 'Austin Development Services',
      permit_number: permit.permit_number,
      permit_type: permit.permit_type,
      permit_type_description: permit.sub_type || permit.work_type,
      issue_date: permit.issue_date,
      status: permit.status,
      work_description: permit.work_type,
      estimated_cost: parseFloat(permit.total_job_valuation || permit.building_valuation) || null,
      contractor_name: null,
      address: permit.permit_location,
      raw: permit
    }));
  } catch (error) {
    console.error('[Austin Permits] Error:', error.message);
    return [];
  }
}

/**
 * Maryland (Montgomery County) Building Permits
 * API: https://data.montgomerycountymd.gov/resource/vv6a-agrn.json
 */
async function fetchMarylandPermits({ address, city, latitude, longitude }) {
  try {
    // Montgomery County uses a different dataset - try searching by street name
    const baseUrl = 'https://data.montgomerycountymd.gov/resource/vv6a-agrn.json';
    
    const cleanAddress = address.split(',')[0].trim().toUpperCase();
    const streetParts = cleanAddress.split(' ');
    const streetName = streetParts.slice(1).join(' '); // Remove house number
    
    const params = new URLSearchParams({
      $where: `upper(stname) like '%${streetName}%'`,
      $limit: 100,
      $order: 'issueddate DESC'
    });
    
    console.log('[MD Permits] Query URL:', `${baseUrl}?${params}`);
    
    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) {
      console.log('[MD Permits] Response not OK:', response.status);
      return [];
    }
    
    const data = await response.json();
    console.log('[MD Permits] Raw results:', data.length);
    
    return data
      .filter(permit => {
        // Filter to exact address match
        const permitAddr = `${permit.addnum || ''} ${permit.stname || ''}`.trim().toUpperCase();
        return permitAddr.includes(cleanAddress.split(' ')[0]); // Match house number
      })
      .map(permit => ({
        source: 'Montgomery County MD DPS',
        permit_number: permit.permitno,
        permit_type: permit.worktype,
        permit_type_description: permit.usecode_desc || permit.worktype,
        issue_date: permit.issueddate ? permit.issueddate.split('T')[0] : null,
        status: permit.status,
        work_description: permit.use_desc || permit.usecode_desc,
        estimated_cost: parseFloat(permit.dclr_val) || null,
        contractor_name: null,
        contractor_company: null,
        address: `${permit.addnum} ${permit.stname}, ${permit.city || 'Montgomery County'}, MD ${permit.zip || ''}`.trim(),
        raw: permit
      }));
  } catch (error) {
    console.error('[Maryland Permits] Error:', error.message);
    return [];
  }
}

/**
 * Washington DC Building Permits
 * API: https://opendata.dc.gov/datasets/building-permits.json
 */
async function fetchDCPermits({ address, latitude, longitude }) {
  try {
    const baseUrl = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/42/query';
    
    const cleanAddress = address.split(',')[0].trim().toUpperCase();
    
    const params = new URLSearchParams({
      where: `UPPER(ADDRESS) LIKE '%${cleanAddress}%'`,
      outFields: '*',
      f: 'json',
      orderByFields: 'ISSUE_DATE DESC',
      resultRecordCount: 50
    });
    
    const response = await fetch(`${baseUrl}?${params}`);
    if (!response.ok) return [];
    
    const data = await response.json();
    
    if (!data.features) return [];
    
    return data.features.map(feature => {
      const attrs = feature.attributes;
      return {
        source: 'DC DCRA',
        permit_number: attrs.PERMIT_NUMBER,
        permit_type: attrs.PERMIT_TYPE,
        permit_type_description: attrs.PERMIT_SUBTYPE,
        issue_date: attrs.ISSUE_DATE ? new Date(attrs.ISSUE_DATE).toISOString().split('T')[0] : null,
        status: attrs.STATUS,
        work_description: attrs.SCOPE_OF_WORK,
        estimated_cost: parseFloat(attrs.ESTIMATED_COST) || null,
        contractor_name: attrs.CONTRACTOR,
        address: attrs.ADDRESS,
        raw: attrs
      };
    });
  } catch (error) {
    console.error('[DC Permits] Error:', error.message);
    return [];
  }
}

/**
 * Normalize permit data to standard format
 */
function normalizePermit(permit) {
  if (!permit) return null;
  
  return {
    source: permit.source || 'Municipality',
    permit_number: permit.permit_number,
    permit_type: permit.permit_type,
    permit_type_description: permit.permit_type_description || permit.permit_type,
    issue_date: permit.issue_date,
    status: permit.status,
    work_description: permit.work_description,
    estimated_cost: permit.estimated_cost,
    contractor_name: permit.contractor_name,
    contractor_company: permit.contractor_company,
    address: permit.address
  };
}

/**
 * Parse city/state from full address string
 */
export function parseAddress(fullAddress) {
  if (!fullAddress) return {};
  
  console.log('[parseAddress] Input:', fullAddress);
  
  // Handle standard format: "123 Main St, City, ST 12345"
  const parts = fullAddress.split(',').map(p => p.trim());
  
  if (parts.length >= 3) {
    const address = parts[0];
    const city = parts[1];
    const stateZip = parts[2].split(' ').filter(Boolean);
    const state = stateZip[0];
    const zip = stateZip[1];
    
    console.log('[parseAddress] Parsed:', { address, city, state, zip });
    return { address, city, state, zip };
  }
  
  // Handle 2-part format: "123 Main St, City ST 12345"
  if (parts.length === 2) {
    const address = parts[0];
    const cityStateZip = parts[1].split(' ').filter(Boolean);
    
    // Try to find state (2-letter code) and zip (5 digits)
    const zipMatch = parts[1].match(/\b\d{5}(-\d{4})?\b/);
    const stateMatch = parts[1].match(/\b[A-Z]{2}\b/);
    
    if (stateMatch) {
      const stateIndex = parts[1].indexOf(stateMatch[0]);
      const city = parts[1].substring(0, stateIndex).trim();
      const state = stateMatch[0];
      const zip = zipMatch ? zipMatch[0] : undefined;
      
      console.log('[parseAddress] Parsed from 2-part:', { address, city, state, zip });
      return { address, city, state, zip };
    }
  }
  
  console.log('[parseAddress] Could not parse, returning:', { address: fullAddress });
  return { address: fullAddress };
}

