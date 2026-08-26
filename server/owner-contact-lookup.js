/**
 * Owner Contact Lookup Service
 * 
 * Provides multiple methods to find contact information for absentee property owners:
 * 1. Public records search via county assessor websites
 * 2. Reverse address lookup using mailing addresses
 * 3. Skip tracing API integration (BeenVerified, Spokeo, etc.)
 * 4. AI-powered contact discovery from web searches
 * 
 * Note: Always comply with applicable laws (TCPA, CAN-SPAM, state regulations)
 */

import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';

// Optional: Third-party skip tracing APIs (add your own keys)
const PEOPLE_DATA_LABS_KEY = process.env.PEOPLE_DATA_LABS_KEY || '';
const HUNTER_IO_KEY = process.env.HUNTER_IO_KEY || '';

/**
 * Check if owner name is a personal trust (vs corporate entity)
 */
function isPersonalTrust(name) {
  if (!name) return false;
  const trustPatterns = /\b(LIVING\s*TRUST|FAMILY\s*TRUST|REVOCABLE\s*TRUST|IRREVOCABLE\s*TRUST|\s+TRUST\s*$)/i;
  return trustPatterns.test(name);
}

/**
 * Extract person name from trust name
 * e.g., "SCHUMACHER,JAMES A & M TRUST" -> { firstName: "JAMES", lastName: "SCHUMACHER" }
 */
function extractNameFromTrust(trustName) {
  if (!trustName) return null;
  
  // Remove trust suffix
  let cleaned = trustName
    .replace(/\s*(LIVING|FAMILY|REVOCABLE|IRREVOCABLE)?\s*TRUST\s*$/i, '')
    .replace(/\s*&\s*[A-Z]\s*$/i, '') // Remove "& M" style co-trustee initials
    .trim();
  
  // Handle "LASTNAME,FIRSTNAME" format
  if (cleaned.includes(',')) {
    const [lastName, firstName] = cleaned.split(',').map(s => s.trim());
    // Take first word of first name (ignore middle initial)
    const firstNameOnly = firstName?.split(/\s+/)[0];
    return { firstName: firstNameOnly, lastName };
  }
  
  // Handle "FIRSTNAME LASTNAME" format
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) {
    return { firstName: parts[0], lastName: parts[parts.length - 1] };
  }
  
  return null;
}

/**
 * Main contact lookup function - tries multiple sources
 * @param {Object} ownerInfo - Owner information from property records
 * @param {Object} propertyInfo - Property details for context
 * @returns {Promise<Object>} Contact information found
 */
export async function lookupOwnerContact(ownerInfo, propertyInfo = {}) {
  console.log('[ContactLookup] Starting lookup for:', ownerInfo.name);
  console.log('[ContactLookup] Config - Google API:', !!GOOGLE_API_KEY, 'CSE:', !!GOOGLE_CSE_CX, 'OpenAI:', !!OPENAI_API_KEY);
  
  const result = {
    ownerName: ownerInfo.name,
    ownerName2: ownerInfo.name2 || null,
    isCorporate: ownerInfo.isCorporate || false,
    mailingAddress: ownerInfo.mailingAddress || '',
    email: null,
    phone: null,
    emailConfidence: 'none',
    phoneConfidence: 'none',
    sources: [],
    lookupDate: new Date().toISOString(),
    searchMethods: [] // Track which methods were tried
  };

  try {
    // Check if this is a personal trust - treat as individual, not corporate
    const isTrust = isPersonalTrust(ownerInfo.name);
    const extractedName = isTrust ? extractNameFromTrust(ownerInfo.name) : null;
    
    if (isTrust && extractedName) {
      console.log('[ContactLookup] Detected personal trust, extracted name:', extractedName);
    }

    // Method 1: If corporate (but NOT personal trust), try to find company contact info
    if (ownerInfo.isCorporate && !isTrust) {
      console.log('[ContactLookup] Trying corporate lookup...');
      result.searchMethods.push('corporate-lookup');
      const corpResult = await lookupCorporateContact(ownerInfo, propertyInfo);
      if (corpResult.email) {
        result.email = corpResult.email;
        result.emailConfidence = corpResult.confidence;
        result.sources.push({ type: 'corporate-lookup', ...corpResult });
        console.log('[ContactLookup] Corporate lookup found:', corpResult.email);
      }
    }

    // Method 2: Try email finder for individuals or trust owners
    if (!result.email) {
      const nameToSearch = extractedName || parseOwnerName(ownerInfo.name);
      if (nameToSearch?.firstName && nameToSearch?.lastName) {
        console.log('[ContactLookup] Trying email finder for:', nameToSearch);
        result.searchMethods.push('email-finder');
        const emailResult = await findEmailFromName({ 
          ...ownerInfo, 
          parsedName: nameToSearch 
        }, propertyInfo);
        if (emailResult.email) {
          result.email = emailResult.email;
          result.emailConfidence = emailResult.confidence;
          result.sources.push({ type: 'email-finder', ...emailResult });
          console.log('[ContactLookup] Email finder found:', emailResult.email);
        }
      }
    }

    // Method 3: People search from mailing address
    if (!result.email || !result.phone) {
      console.log('[ContactLookup] Trying address lookup for:', ownerInfo.mailingAddress?.substring(0, 50));
      result.searchMethods.push('address-lookup');
      const addressResult = await lookupFromMailingAddress(ownerInfo);
      if (addressResult.email && !result.email) {
        result.email = addressResult.email;
        result.emailConfidence = addressResult.emailConfidence;
        console.log('[ContactLookup] Address lookup found email:', addressResult.email);
      }
      if (addressResult.phone && !result.phone) {
        result.phone = addressResult.phone;
        result.phoneConfidence = addressResult.phoneConfidence;
        console.log('[ContactLookup] Address lookup found phone:', addressResult.phone);
      }
      if (addressResult.email || addressResult.phone) {
        result.sources.push({ type: 'address-lookup', ...addressResult });
      }
    }

    // Method 4: AI-powered web search (last resort)
    if (!result.email && OPENAI_API_KEY) {
      console.log('[ContactLookup] Trying AI-powered search...');
      result.searchMethods.push('ai-search');
      const searchName = extractedName 
        ? `${extractedName.firstName} ${extractedName.lastName}`
        : ownerInfo.name;
      const aiResult = await aiPoweredContactSearch({ ...ownerInfo, searchName }, propertyInfo);
      if (aiResult.email) {
        result.email = aiResult.email;
        result.emailConfidence = aiResult.confidence;
        result.sources.push({ type: 'ai-search', ...aiResult });
        console.log('[ContactLookup] AI search found:', aiResult.email);
      }
    }

    // Calculate overall confidence
    result.overallConfidence = calculateOverallConfidence(result);
    
    console.log('[ContactLookup] Final result - email:', result.email, 'phone:', result.phone, 'methods tried:', result.searchMethods);

  } catch (error) {
    console.error('[ContactLookup] Error:', error.message);
    result.error = error.message;
  }

  return result;
}

/**
 * Lookup corporate entity contact information
 */
async function lookupCorporateContact(ownerInfo, propertyInfo) {
  const result = { email: null, phone: null, confidence: 'low', method: 'corporate' };
  
  try {
    // Try to find company website from Google search
    if (GOOGLE_API_KEY && GOOGLE_CSE_CX) {
      const companyName = ownerInfo.name.replace(/\s*(LLC|INC|CORP|LP|LTD|TRUST)\.?\s*$/i, '').trim();
      const searchQuery = `"${companyName}" contact email`;
      
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(searchQuery)}&num=5`;
      const response = await fetch(searchUrl);
      
      if (response.ok) {
        const data = await response.json();
        
        // Look for email patterns in search results
        for (const item of (data.items || [])) {
          const snippet = (item.snippet || '') + ' ' + (item.title || '');
          const emailMatch = snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch && !emailMatch[0].includes('example')) {
            result.email = emailMatch[0].toLowerCase();
            result.confidence = 'medium';
            result.source = item.link;
            break;
          }
        }
      }
    }
  } catch (error) {
    console.log('[ContactLookup] Corporate lookup error:', error.message);
  }
  
  return result;
}

/**
 * Validate if an email looks legitimate for a personal property owner
 * Returns { valid: boolean, reason: string }
 */
function validatePersonalEmail(email, ownerInfo) {
  const emailLower = email.toLowerCase();
  const domain = emailLower.split('@')[1] || '';
  
  // Reject obvious institutional/role-based emails
  const rolePatterns = [
    'tickets@', 'info@', 'contact@', 'support@', 'sales@', 'admin@',
    'noreply@', 'no-reply@', 'donotreply@', 'newsletter@', 'marketing@',
    'hr@', 'jobs@', 'careers@', 'press@', 'media@', 'webmaster@',
    'postmaster@', 'abuse@', 'security@', 'billing@', 'help@'
  ];
  
  for (const pattern of rolePatterns) {
    if (emailLower.includes(pattern)) {
      console.log(`[ContactLookup] Rejected email ${email}: role-based pattern "${pattern}"`);
      return { valid: false, reason: 'role-based email' };
    }
  }
  
  // Reject .edu emails (usually not personal for property owners)
  if (domain.endsWith('.edu')) {
    console.log(`[ContactLookup] Rejected email ${email}: educational institution`);
    return { valid: false, reason: 'educational institution' };
  }
  
  // Reject .gov emails
  if (domain.endsWith('.gov')) {
    console.log(`[ContactLookup] Rejected email ${email}: government email`);
    return { valid: false, reason: 'government email' };
  }
  
  // Check if email contains owner's name (increases confidence)
  const nameParts = parseOwnerName(ownerInfo.name);
  const emailLocal = emailLower.split('@')[0];
  
  const containsFirstName = nameParts.firstName && emailLocal.includes(nameParts.firstName.toLowerCase());
  const containsLastName = nameParts.lastName && emailLocal.includes(nameParts.lastName.toLowerCase());
  
  if (containsFirstName || containsLastName) {
    console.log(`[ContactLookup] Email ${email} contains owner name - higher confidence`);
    return { valid: true, reason: 'contains owner name', confidence: 'medium' };
  }
  
  // Generic validation passed but low confidence
  return { valid: true, reason: 'passed basic validation', confidence: 'low' };
}

/**
 * Find email using name and location information
 * Uses common email patterns and verification
 */
async function findEmailFromName(ownerInfo, propertyInfo) {
  const result = { email: null, confidence: 'low', method: 'email-pattern' };
  
  try {
    // Parse owner name
    const nameParts = parseOwnerName(ownerInfo.name);
    if (!nameParts.firstName || !nameParts.lastName) {
      return result;
    }

    console.log('[ContactLookup] Trying email finder for:', nameParts);

    // Try Hunter.io if API key is available
    if (HUNTER_IO_KEY) {
      const hunterResult = await hunterEmailFinder(nameParts, ownerInfo);
      if (hunterResult.email) {
        const validation = validatePersonalEmail(hunterResult.email, ownerInfo);
        if (validation.valid) {
          console.log('[ContactLookup] Hunter.io found valid email:', hunterResult.email);
          return hunterResult;
        }
      }
    }

    // Try People Data Labs if available
    if (PEOPLE_DATA_LABS_KEY) {
      const pdlResult = await peopleDataLabsLookup(nameParts, ownerInfo);
      if (pdlResult.email) {
        const validation = validatePersonalEmail(pdlResult.email, ownerInfo);
        if (validation.valid) {
          console.log('[ContactLookup] PDL found valid email:', pdlResult.email);
          return pdlResult;
        }
      }
    }

    // Web search for person's professional email - now with stricter location filter
    if (GOOGLE_API_KEY && GOOGLE_CSE_CX) {
      // Include state to reduce false positives from people with same name in different locations
      const location = ownerInfo.mailingCity && ownerInfo.mailingState 
        ? `${ownerInfo.mailingCity} ${ownerInfo.mailingState}` 
        : (ownerInfo.mailingCity || '');
      
      const searchQuery = `"${nameParts.firstName} ${nameParts.lastName}" ${location} email contact`;
      console.log('[ContactLookup] Web search query:', searchQuery);
      
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(searchQuery)}&num=10`;
      const response = await fetch(searchUrl);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`[ContactLookup] Web search returned ${data.items?.length || 0} results`);
        
        // Collect all potential emails and validate
        const potentialEmails = [];
        
        for (const item of (data.items || [])) {
          const snippet = (item.snippet || '') + ' ' + (item.pagemap?.metatags?.[0]?.['og:description'] || '');
          const emailMatches = snippet.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          
          for (const emailMatch of emailMatches) {
            const email = emailMatch.toLowerCase();
            if (email.includes('example') || email.includes('sentry')) continue;
            
            const validation = validatePersonalEmail(email, ownerInfo);
            if (validation.valid) {
              potentialEmails.push({
                email,
                confidence: validation.confidence,
                source: item.link
              });
            }
          }
        }
        
        // Sort by confidence and return best match
        if (potentialEmails.length > 0) {
          potentialEmails.sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return (order[a.confidence] || 3) - (order[b.confidence] || 3);
          });
          
          const best = potentialEmails[0];
          console.log('[ContactLookup] Email finder found:', best.email, 'confidence:', best.confidence);
          result.email = best.email;
          result.confidence = best.confidence;
          result.source = best.source;
        } else {
          console.log('[ContactLookup] No valid personal emails found in web search');
        }
      }
    }
  } catch (error) {
    console.log('[ContactLookup] Email finder error:', error.message);
  }
  
  return result;
}

/**
 * Lookup contact info from mailing address using reverse address lookup
 */
async function lookupFromMailingAddress(ownerInfo) {
  const result = { 
    email: null, 
    phone: null, 
    emailConfidence: 'none', 
    phoneConfidence: 'none',
    method: 'address-lookup' 
  };
  
  // Note: In production, you would integrate with skip tracing services like:
  // - BatchSkipTracing.com
  // - PropStream
  // - REIPro
  // - REsimpli
  
  // For now, we'll use web search as a fallback
  try {
    if (GOOGLE_API_KEY && GOOGLE_CSE_CX && ownerInfo.mailingAddress) {
      // Clean up address for search
      const addressClean = ownerInfo.mailingAddress.replace(/[,#]/g, ' ').trim();
      const searchQuery = `"${addressClean}" contact email phone`;
      
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(searchQuery)}&num=3`;
      const response = await fetch(searchUrl);
      
      if (response.ok) {
        const data = await response.json();
        
        for (const item of (data.items || [])) {
          const text = (item.snippet || '') + ' ' + (item.title || '');
          
          // Look for email
          if (!result.email) {
            const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch && !emailMatch[0].includes('example')) {
              result.email = emailMatch[0].toLowerCase();
              result.emailConfidence = 'low';
            }
          }
          
          // Look for phone
          if (!result.phone) {
            const phoneMatch = text.match(/\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/);
            if (phoneMatch) {
              result.phone = phoneMatch[0].replace(/[^0-9]/g, '');
              result.phoneConfidence = 'low';
            }
          }
        }
      }
    }
  } catch (error) {
    console.log('[ContactLookup] Address lookup error:', error.message);
  }
  
  return result;
}

/**
 * AI-powered contact search using OpenAI
 * Uses web search results and AI to extract contact info
 */
async function aiPoweredContactSearch(ownerInfo, propertyInfo) {
  const result = { email: null, phone: null, confidence: 'none', method: 'ai-search' };
  
  if (!OPENAI_API_KEY) {
    console.log('[ContactLookup] AI search skipped - no OpenAI API key');
    return result;
  }
  
  try {
    // Use searchName if available (extracted from trust name), otherwise use raw name
    const searchName = ownerInfo.searchName || ownerInfo.name;
    console.log('[ContactLookup] AI search using name:', searchName);
    
    // First, gather web search results
    let searchContext = '';
    
    if (GOOGLE_API_KEY && GOOGLE_CSE_CX) {
      // Build more targeted queries
      const mailingCity = ownerInfo.mailingCity || '';
      const mailingState = ownerInfo.mailingState || '';
      const location = [mailingCity, mailingState].filter(Boolean).join(', ');
      
      const queries = [
        `"${searchName}" email contact`,
        location ? `"${searchName}" ${location}` : null,
        ownerInfo.mailingAddress ? `"${searchName}" real estate investor` : null
      ].filter(Boolean);
      
      console.log('[ContactLookup] AI search queries:', queries);
      
      for (const query of queries.slice(0, 2)) {
        try {
          const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(query)}&num=5`;
          const response = await fetch(searchUrl);
          
          if (response.ok) {
            const data = await response.json();
            console.log('[ContactLookup] Google search returned', data.items?.length || 0, 'results for:', query);
            
            for (const item of (data.items || [])) {
              searchContext += `Source: ${item.link}\nTitle: ${item.title}\nSnippet: ${item.snippet}\n\n`;
            }
          } else {
            const errorText = await response.text();
            console.log('[ContactLookup] Google search error:', response.status, errorText.substring(0, 200));
          }
        } catch (searchError) {
          console.log('[ContactLookup] Search query failed:', searchError.message);
        }
      }
    } else {
      console.log('[ContactLookup] Google search skipped - missing API key or CSE CX');
    }
    
    if (!searchContext) {
      console.log('[ContactLookup] No search context gathered, skipping AI extraction');
      return result;
    }
    
    console.log('[ContactLookup] Sending to OpenAI for extraction, context length:', searchContext.length);
    
    // Use AI to extract contact information
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a contact information extractor. Your task is to find email addresses and phone numbers for a specific person from web search results.

The person you're looking for: "${searchName}"
${ownerInfo.mailingAddress ? `Their mailing address: ${ownerInfo.mailingAddress}` : ''}

Instructions:
1. Look for email addresses that clearly belong to this person
2. Look for phone numbers associated with them
3. Be careful not to confuse them with other people with similar names
4. Only return contact info you're reasonably confident belongs to them

Return ONLY valid JSON in this exact format:
{
  "email": "found email address or null",
  "phone": "found phone number or null", 
  "confidence": "high" | "medium" | "low" | "none",
  "reasoning": "brief explanation of why you believe this contact belongs to them"
}`
          },
          {
            role: 'user',
            content: `Find contact information for: ${searchName}

Web search results:
${searchContext.substring(0, 4000)}`
          }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    });
    
    if (aiResponse.ok) {
      const aiData = await aiResponse.json();
      const content = aiData.choices?.[0]?.message?.content || '';
      console.log('[ContactLookup] AI response:', content.substring(0, 300));
      
      try {
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          result.email = parsed.email;
          result.phone = parsed.phone;
          result.confidence = parsed.confidence || 'low';
          result.reasoning = parsed.reasoning;
          console.log('[ContactLookup] AI extracted:', { email: result.email, phone: result.phone, confidence: result.confidence });
        }
      } catch (e) {
        console.log('[ContactLookup] AI response parse error:', e.message, 'Raw:', content.substring(0, 200));
      }
    } else {
      const errorText = await aiResponse.text();
      console.log('[ContactLookup] OpenAI API error:', aiResponse.status, errorText.substring(0, 200));
    }
  } catch (error) {
    console.log('[ContactLookup] AI search error:', error.message);
  }
  
  return result;
}

/**
 * Hunter.io email finder integration
 */
async function hunterEmailFinder(nameParts, ownerInfo) {
  const result = { email: null, confidence: 'none', method: 'hunter.io' };
  
  if (!HUNTER_IO_KEY) return result;
  
  try {
    // Hunter's email finder API
    const url = `https://api.hunter.io/v2/email-finder?first_name=${encodeURIComponent(nameParts.firstName)}&last_name=${encodeURIComponent(nameParts.lastName)}&api_key=${HUNTER_IO_KEY}`;
    
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.data?.email) {
        result.email = data.data.email;
        result.confidence = data.data.score >= 80 ? 'high' : data.data.score >= 50 ? 'medium' : 'low';
        result.score = data.data.score;
      }
    }
  } catch (error) {
    console.log('[ContactLookup] Hunter.io error:', error.message);
  }
  
  return result;
}

/**
 * People Data Labs lookup integration
 */
async function peopleDataLabsLookup(nameParts, ownerInfo) {
  const result = { email: null, phone: null, confidence: 'none', method: 'people-data-labs' };
  
  if (!PEOPLE_DATA_LABS_KEY) return result;
  
  try {
    const params = new URLSearchParams({
      name: `${nameParts.firstName} ${nameParts.lastName}`,
      locality: ownerInfo.mailingCity || '',
      region: ownerInfo.mailingState || '',
      postal_code: ownerInfo.mailingZip || '',
      pretty: 'true'
    });
    
    const url = `https://api.peopledatalabs.com/v5/person/enrich?${params.toString()}`;
    
    const response = await fetch(url, {
      headers: {
        'X-Api-Key': PEOPLE_DATA_LABS_KEY
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.data) {
        // Get primary email
        if (data.data.emails?.length > 0) {
          result.email = data.data.emails[0].address;
          result.confidence = 'high';
        }
        // Get primary phone
        if (data.data.phone_numbers?.length > 0) {
          result.phone = data.data.phone_numbers[0];
          result.phoneConfidence = 'high';
        }
      }
    }
  } catch (error) {
    console.log('[ContactLookup] People Data Labs error:', error.message);
  }
  
  return result;
}

/**
 * Parse owner name into first and last name
 */
function parseOwnerName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  
  // Remove common suffixes
  const cleaned = fullName
    .replace(/\s*(JR|SR|II|III|IV|ESQ)\.?\s*$/i, '')
    .replace(/\s*(TRUSTEE|TRUST|REVOCABLE|LIVING).*$/i, '')
    .trim();
  
  const parts = cleaned.split(/\s+/);
  
  if (parts.length === 1) {
    return { firstName: null, lastName: parts[0] };
  }
  
  if (parts.length === 2) {
    return { firstName: parts[0], lastName: parts[1] };
  }
  
  // Handle "LAST, FIRST" format
  if (cleaned.includes(',')) {
    const [last, first] = cleaned.split(',').map(s => s.trim());
    return { firstName: first?.split(' ')[0], lastName: last };
  }
  
  // Assume first word is first name, last word is last name
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/**
 * Calculate overall confidence based on sources
 */
function calculateOverallConfidence(result) {
  if (!result.email && !result.phone) return 'none';
  
  const confidenceMap = { high: 3, medium: 2, low: 1, none: 0 };
  const emailScore = confidenceMap[result.emailConfidence] || 0;
  const phoneScore = confidenceMap[result.phoneConfidence] || 0;
  
  const avgScore = (emailScore + phoneScore) / 2;
  
  if (avgScore >= 2.5) return 'high';
  if (avgScore >= 1.5) return 'medium';
  if (avgScore >= 0.5) return 'low';
  return 'none';
}

/**
 * Batch lookup for multiple owners
 */
export async function batchLookupOwnerContacts(owners, propertyInfos = []) {
  const results = [];
  
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    const property = propertyInfos[i] || {};
    
    // Rate limiting - wait between lookups
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const result = await lookupOwnerContact(owner, property);
    results.push(result);
  }
  
  return results;
}

export { parseOwnerName, calculateOverallConfidence };
