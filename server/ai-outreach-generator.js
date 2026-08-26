/**
 * AI-Powered Outreach Email Generator
 * 
 * Uses GPT-5 (or GPT-4o) to generate personalized, professional outreach emails
 * for contacting absentee property owners about potential property purchases.
 * 
 * Features:
 * - Personalized based on property details and owner situation
 * - Adjustable tone (casual, professional, formal)
 * - Includes buyer's offer details and questions
 * - Compliant with real estate communication best practices
 * - Follow-up email generation
 */

import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o'; // Use GPT-5 when available

/**
 * Generate a personalized outreach email to an absentee property owner
 * 
 * @param {Object} options - Email generation options
 * @param {Object} options.property - Property details
 * @param {Object} options.owner - Owner information
 * @param {Object} options.buyer - Buyer information and preferences
 * @param {string} options.tone - Email tone: 'casual', 'professional', 'formal'
 * @param {string[]} options.questions - Additional questions to include
 * @param {Object} options.offer - Offer details
 * @returns {Promise<Object>} Generated email with subject and body
 */
export async function generateOutreachEmail(options) {
  const {
    property = {},
    owner = {},
    buyer = {},
    tone = 'professional',
    questions = [],
    offer = {},
    insuranceEstimate = null,
    purpose = 'acquisition',
    isFollowUp = false,
    previousEmailDate = null,
    enrichmentContext = '',
  } = options;

  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      error: 'OpenAI API key not configured'
    };
  }

  try {
    // Build context for the AI
    const propertyContext = buildPropertyContext(property);
    const ownerContext = buildOwnerContext(owner);
    const buyerContext = buildBuyerContext(buyer);
    const offerContext = buildOfferContext(offer, property);
    const insuranceContext = buildInsuranceContext(insuranceEstimate);
    const questionsContext = questions.length > 0 
      ? `\nAdditional questions to include:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    const systemPrompt = getSystemPrompt(tone, isFollowUp, purpose);
    
    const userPrompt = purpose === 'iot_protection'
      ? buildIotProtectionPrompt({
          tone,
          isFollowUp,
          previousEmailDate,
          propertyContext,
          ownerContext,
          buyerContext,
          insuranceContext,
          questionsContext,
          enrichmentContext,
        })
      : `Generate a ${isFollowUp ? 'follow-up ' : ''}${tone} outreach email for this situation:

PROPERTY INFORMATION:
${propertyContext}

PROPERTY OWNER:
${ownerContext}

BUYER INFORMATION:
${buyerContext}

OFFER DETAILS:
${offerContext}
${questionsContext}

${isFollowUp ? `Previous email was sent on: ${previousEmailDate || 'a few days ago'}` : ''}

Generate a compelling email that:
1. Opens with a personalized, non-intrusive greeting
2. Clearly states the buyer's interest in the property
3. Mentions the potential offer amount naturally
4. Includes any specific questions the buyer has
5. Provides clear next steps for the owner
6. Ends with a professional closing

Return the email in this exact JSON format:
{
  "subject": "Email subject line",
  "greeting": "Opening greeting",
  "body": "Main email body (multiple paragraphs)",
  "closing": "Closing paragraph with call to action",
  "signature": "Signature block",
  "followUpSuggestion": "When and how to follow up if no response"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `OpenAI API error: ${response.status}`,
        detail: errorText
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse the JSON response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const emailData = JSON.parse(jsonMatch[0]);
        
        // Compose full email
        const fullEmail = composeFullEmail(emailData, buyer);
        
        return {
          ok: true,
          email: {
            subject: emailData.subject,
            body: fullEmail,
            greeting: emailData.greeting,
            mainBody: emailData.body,
            closing: emailData.closing,
            signature: emailData.signature,
            followUpSuggestion: emailData.followUpSuggestion
          },
          metadata: {
            tone,
            isFollowUp,
            generatedAt: new Date().toISOString(),
            propertyAddress: property.address,
            ownerName: owner.name,
            offerAmount: offer.amount
          }
        };
      } else {
        // If no JSON, try to use the raw content as the email body
        return {
          ok: true,
          email: {
            subject: `Regarding ${property.address || 'Your Property'}`,
            body: content,
            greeting: '',
            mainBody: content,
            closing: '',
            signature: buyer.signature || '',
            followUpSuggestion: 'Follow up in 5-7 days if no response'
          },
          metadata: {
            tone,
            isFollowUp,
            generatedAt: new Date().toISOString(),
            rawResponse: true
          }
        };
      }
    } catch (parseError) {
      return {
        ok: false,
        error: 'Failed to parse AI response',
        rawContent: content
      };
    }

  } catch (error) {
    console.error('[AIOutreach] Generation error:', error);
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Generate multiple email variants for A/B testing
 */
export async function generateEmailVariants(options, count = 3) {
  const variants = [];
  const tones = ['casual', 'professional', 'formal'];
  
  for (let i = 0; i < Math.min(count, 3); i++) {
    const variant = await generateOutreachEmail({
      ...options,
      tone: tones[i] || 'professional'
    });
    
    if (variant.ok) {
      variants.push({
        variant: i + 1,
        tone: tones[i],
        ...variant.email
      });
    }
    
    // Small delay between API calls
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  return {
    ok: variants.length > 0,
    variants,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Generate a follow-up email sequence
 */
export async function generateFollowUpSequence(options, sequenceLength = 3) {
  const sequence = [];
  const intervals = ['3 days', '7 days', '14 days'];
  
  // First email
  const firstEmail = await generateOutreachEmail(options);
  if (firstEmail.ok) {
    sequence.push({
      emailNumber: 1,
      sendAfter: 'immediately',
      ...firstEmail.email
    });
  }
  
  // Follow-up emails
  for (let i = 1; i < sequenceLength; i++) {
    const followUp = await generateOutreachEmail({
      ...options,
      isFollowUp: true,
      previousEmailDate: intervals[i - 1]
    });
    
    if (followUp.ok) {
      sequence.push({
        emailNumber: i + 1,
        sendAfter: intervals[i - 1],
        ...followUp.email
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  return {
    ok: sequence.length > 0,
    sequence,
    totalEmails: sequence.length,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Analyze and improve an existing email
 */
export async function improveOutreachEmail(emailText, feedback = '') {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OpenAI API key not configured' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are an expert real estate communication specialist. Analyze and improve outreach emails to property owners. Focus on:
- Making the email more personalized and genuine
- Improving clarity and call-to-action
- Ensuring professional yet friendly tone
- Removing any language that might seem pushy or like spam
- Ensuring compliance with real estate communication best practices`
          },
          {
            role: 'user',
            content: `Please improve this outreach email:

${emailText}

${feedback ? `Specific feedback to address: ${feedback}` : ''}

Return the improved email in JSON format:
{
  "subject": "Improved subject line",
  "body": "Improved email body",
  "changes": ["List of key changes made"],
  "suggestions": ["Additional suggestions for improvement"]
}`
          }
        ],
        temperature: 0.6,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      return { ok: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const improved = JSON.parse(jsonMatch[0]);
      return {
        ok: true,
        improved: {
          subject: improved.subject,
          body: improved.body
        },
        changes: improved.changes || [],
        suggestions: improved.suggestions || []
      };
    }
    
    return { ok: false, error: 'Could not parse improvement response' };
    
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// === Helper Functions ===

function getSystemPrompt(tone, isFollowUp, purpose = 'acquisition') {
  const basePrompt = purpose === 'iot_protection'
    ? `You are a HouseYield remote property protection specialist. You write respectful outreach emails to absentee property owners about pre-configured leak monitoring and automatic water shutoff — not about buying their property.

Your emails should:
- Lead with remote ownership risk (water damage while nobody is on-site)
- Explain that devices are pre-configured before shipping and a local installer only mounts hardware
- Mention estimated insurance premium savings when provided (as potential credits, not guaranteed)
- Offer a short call or portfolio review — never high pressure
- Sound operational and helpful, not salesy

Never use:
- Language about purchasing or making offers on the property
- Guaranteed insurance discount claims
- False urgency or fear tactics`
    : `You are an expert real estate investor communication specialist. You help investors write compelling, professional outreach emails to property owners who may be interested in selling their properties.

Your emails should:
- Be genuine and respectful, not pushy or salesy
- Acknowledge the owner's situation without making assumptions
- Clearly communicate the buyer's interest and capability
- Include specific details about the property to show research
- Provide easy ways to respond or get more information
- Comply with CAN-SPAM and real estate communication regulations

Never use:
- High-pressure tactics
- False urgency
- Misleading statements
- Overly familiar language with strangers
- Generic templates that feel impersonal`;

  const toneGuides = {
    casual: `\n\nTone: Friendly and conversational. Use natural language, contractions, and a warm approach. Still professional but feels like a neighbor reaching out.`,
    professional: `\n\nTone: Professional and business-like. Clear, direct, and respectful. Standard business communication style.`,
    formal: `\n\nTone: Formal and traditional. More structured language, complete sentences, traditional business letter style.`
  };

  const followUpAddition = isFollowUp 
    ? `\n\nThis is a FOLLOW-UP email. Acknowledge the previous email briefly, add new value or information, and reiterate interest without being pushy.`
    : '';

  return basePrompt + (toneGuides[tone] || toneGuides.professional) + followUpAddition;
}

function buildPropertyContext(property) {
  const details = [];
  
  if (property.address) details.push(`Address: ${property.address}`);
  if (property.city) details.push(`City: ${property.city}, ${property.state || ''}`);
  if (property.propertyType) details.push(`Property Type: ${property.propertyType}`);
  if (property.beds) details.push(`Bedrooms: ${property.beds}`);
  if (property.baths) details.push(`Bathrooms: ${property.baths}`);
  if (property.sqft) details.push(`Square Feet: ${property.sqft.toLocaleString()}`);
  if (property.yearBuilt) details.push(`Year Built: ${property.yearBuilt}`);
  if (property.lotSizeAcres) details.push(`Lot Size: ${property.lotSizeAcres} acres`);
  if (property.assessedValue) details.push(`Assessed Value: $${property.assessedValue.toLocaleString()}`);
  if (property.marketValue) details.push(`Estimated Market Value: $${property.marketValue.toLocaleString()}`);
  
  return details.join('\n') || 'Property details not provided';
}

function buildOwnerContext(owner) {
  const details = [];
  
  if (owner.name) details.push(`Name: ${owner.name}`);
  if (owner.name2) details.push(`Co-owner: ${owner.name2}`);
  if (owner.isCorporate) details.push(`Type: Corporate/LLC Owner`);
  if (owner.mailingAddress) details.push(`Mailing Address: ${owner.mailingAddress}`);
  if (owner.ownershipYears) details.push(`Years of Ownership: ${owner.ownershipYears}`);
  if (owner.likelyFreeAndClear) details.push(`Mortgage Status: Likely owns free and clear`);
  if (owner.motivationScore) details.push(`Motivation Score: ${owner.motivationScore}/100`);
  if (owner.motivationFactors?.length) {
    details.push(`Motivation Factors: ${owner.motivationFactors.join(', ')}`);
  }
  
  return details.join('\n') || 'Owner details not provided';
}

function buildBuyerContext(buyer) {
  const details = [];
  
  if (buyer.name) details.push(`Name: ${buyer.name}`);
  if (buyer.company) details.push(`Company: ${buyer.company}`);
  if (buyer.phone) details.push(`Phone: ${buyer.phone}`);
  if (buyer.email) details.push(`Email: ${buyer.email}`);
  if (buyer.investmentStyle) details.push(`Investment Style: ${buyer.investmentStyle}`);
  if (buyer.experience) details.push(`Experience: ${buyer.experience}`);
  if (buyer.preferredClose) details.push(`Preferred Closing Timeline: ${buyer.preferredClose}`);
  if (buyer.paymentMethod) details.push(`Payment Method: ${buyer.paymentMethod}`);
  
  return details.join('\n') || 'Buyer information not provided';
}

function buildOfferContext(offer, property) {
  const details = [];
  
  if (offer.amount) {
    details.push(`Offer Amount: $${Number(offer.amount).toLocaleString()}`);
    
    // Calculate percentage of market value if available
    if (property.marketValue) {
      const percentage = ((offer.amount / property.marketValue) * 100).toFixed(1);
      details.push(`Percentage of Market Value: ${percentage}%`);
    }
  }
  
  if (offer.range) {
    details.push(`Offer Range: ${offer.range}`);
  }
  
  if (offer.terms) details.push(`Terms: ${offer.terms}`);
  if (offer.closingTimeline) details.push(`Closing Timeline: ${offer.closingTimeline}`);
  if (offer.paymentType) details.push(`Payment Type: ${offer.paymentType}`);
  if (offer.contingencies) details.push(`Contingencies: ${offer.contingencies}`);
  if (offer.flexibility) details.push(`Flexibility: ${offer.flexibility}`);
  
  return details.join('\n') || 'Making a competitive cash offer';
}

function buildInsuranceContext(insuranceEstimate) {
  if (!insuranceEstimate) {
    return 'No insurance savings estimate provided.';
  }

  const typical = insuranceEstimate.mitigationCredit?.typical || insuranceEstimate.recommendedPitch;
  const lines = [
    `Estimated annual premium: $${Number(insuranceEstimate.estimatedAnnualPremium || 0).toLocaleString()}`,
    `Estimated monthly premium: $${Number(insuranceEstimate.estimatedMonthlyPremium || 0).toLocaleString()}`,
  ];

  if (typical?.annualSavings) {
    lines.push(`Typical mitigation credit: ~$${Number(typical.annualSavings).toLocaleString()}/year (~$${Number(typical.monthlySavings).toLocaleString()}/month)`);
  }
  if (insuranceEstimate.recommendedPitch?.netMonthlyAfterMonitoring != null) {
    lines.push(`Net monthly benefit after HouseYield monitoring: ~$${Number(insuranceEstimate.recommendedPitch.netMonthlyAfterMonitoring).toLocaleString()}/month`);
  }
  if (insuranceEstimate.disclaimer) {
    lines.push(`Disclaimer to respect: ${insuranceEstimate.disclaimer}`);
  }

  return lines.join('\n');
}

function buildIotProtectionPrompt({
  tone,
  isFollowUp,
  previousEmailDate,
  propertyContext,
  ownerContext,
  buyerContext,
  insuranceContext,
  questionsContext,
  enrichmentContext = '',
}) {
  return `Generate a ${isFollowUp ? 'follow-up ' : ''}${tone} HouseYield remote water protection outreach email:

PROPERTY INFORMATION:
${propertyContext}

PROPERTY OWNER:
${ownerContext}

SENDER / COMPANY:
${buyerContext}

INSURANCE SAVINGS ESTIMATE:
${insuranceContext}

LEAD ENRICHMENT (rental + leak risk signals):
${enrichmentContext || 'No enrichment data available.'}
${questionsContext}

${isFollowUp ? `Previous email was sent on: ${previousEmailDate || 'a few days ago'}` : ''}

Generate an email that:
1. Acknowledges they own property remotely (mailing address differs from property if applicable)
2. If enrichment shows likely rental occupancy, mention tenant-on-site / owner-off-site leak risk
3. Explains HouseYield pre-configured leak sensors + automatic shutoff with no owner on-site for Wi-Fi setup
4. Uses the insurance savings estimate as "potential premium credit" language — not a guarantee
5. Offers a 15-minute portfolio protection review
6. Keeps the message concise and professional
7. Do not mention yard drainage, pooling, or flood zone issues — focus on indoor leak detection

Return the email in this exact JSON format:
{
  "subject": "Email subject line",
  "greeting": "Opening greeting",
  "body": "Main email body (multiple paragraphs)",
  "closing": "Closing paragraph with call to action",
  "signature": "Signature block",
  "followUpSuggestion": "When and how to follow up if no response"
}`;
}

function composeFullEmail(emailData, buyer) {
  const parts = [];
  
  if (emailData.greeting) {
    parts.push(emailData.greeting);
    parts.push('');
  }
  
  if (emailData.body) {
    parts.push(emailData.body);
    parts.push('');
  }
  
  if (emailData.closing) {
    parts.push(emailData.closing);
    parts.push('');
  }
  
  // Add signature
  if (emailData.signature) {
    parts.push(emailData.signature);
  } else if (buyer.name) {
    parts.push(`Best regards,`);
    parts.push(buyer.name);
    if (buyer.company) parts.push(buyer.company);
    if (buyer.phone) parts.push(buyer.phone);
    if (buyer.email) parts.push(buyer.email);
  }
  
  return parts.join('\n');
}

/**
 * Template-based quick email generation (for when API is unavailable)
 */
export function generateTemplateEmail(options) {
  const { property, owner, buyer, offer, insuranceEstimate, purpose = 'acquisition' } = options;
  
  const ownerName = owner?.name?.split(' ')[0] || 'Property Owner';
  const propertyAddress = property?.address || 'your property';
  const buyerName = buyer?.name || 'HouseYield';
  const companyName = buyer?.company || 'HouseYield';

  if (purpose === 'iot_protection') {
    const monthlySavings = insuranceEstimate?.mitigationCredit?.typical?.monthlySavings
      || insuranceEstimate?.recommendedPitch?.headlineMonthlySavings
      || 0;
    const annualPremium = insuranceEstimate?.estimatedAnnualPremium || 0;
    const subject = `Remote water protection for ${propertyAddress}`;
    const body = `Dear ${ownerName},

I'm reaching out from ${companyName} because you appear to own ${propertyAddress} while your mailing address is elsewhere — a setup we see often with out-of-state rentals and second homes.

HouseYield installs pre-configured leak sensors and automatic water shutoff so you do not need to be on-site for Wi-Fi setup. We program devices at our bench, ship the kit, and a local installer only mounts hardware and plugs in power.

${annualPremium ? `Based on typical landlord premiums for this property, your insurance may run about $${Number(annualPremium).toLocaleString()} per year.` : ''}${monthlySavings ? ` After installing a documented HouseYield mitigation system, many carriers consider premium credits that could save roughly $${Number(monthlySavings).toLocaleString()}/month — actual credits depend on your carrier and policy.` : ''}

Would you be open to a 15-minute call to review a protection plan for this property?

Best regards,
${buyerName}
${buyer?.phone ? buyer.phone + '\n' : ''}${buyer?.email || ''}`;

    return {
      ok: true,
      email: {
        subject,
        body,
        greeting: `Dear ${ownerName},`,
        mainBody: body,
        closing: 'Would you be open to a 15-minute call to review a protection plan for this property?',
        signature: `Best regards,\n${buyerName}`,
        followUpSuggestion: 'Follow up in 5-7 days if no response'
      },
      metadata: {
        tone: 'professional',
        isTemplate: true,
        purpose,
        generatedAt: new Date().toISOString()
      }
    };
  }

  const offerAmount = offer?.amount 
    ? `$${Number(offer.amount).toLocaleString()}`
    : 'a competitive cash offer';
  
  const subject = `Interest in ${propertyAddress}`;
  
  const body = `Dear ${ownerName},

I hope this message finds you well. My name is ${buyerName}${buyer?.company ? ` with ${buyer.company}` : ''}, and I'm reaching out because I'm interested in purchasing the property at ${propertyAddress}.

I understand you may not be actively looking to sell, and that's completely okay. However, if you've ever considered selling or would be open to discussing a potential sale, I'd love to have a conversation.

I'm prepared to offer ${offerAmount} and can work with your timeline for closing. I'm a serious buyer${buyer?.paymentMethod ? ` with ${buyer.paymentMethod} ready` : ''}, and I handle transactions professionally and efficiently.

${offer?.flexibility ? `I'm flexible on terms and happy to discuss what would work best for you.` : ''}

If you're interested in learning more or just want to explore your options, please feel free to reach out at your convenience.

Best regards,
${buyerName}
${buyer?.company ? buyer.company + '\n' : ''}${buyer?.phone ? buyer.phone + '\n' : ''}${buyer?.email || ''}`;

  return {
    ok: true,
    email: {
      subject,
      body,
      greeting: `Dear ${ownerName},`,
      mainBody: body,
      closing: 'If you\'re interested in learning more or just want to explore your options, please feel free to reach out at your convenience.',
      signature: `Best regards,\n${buyerName}`,
      followUpSuggestion: 'Follow up in 7 days if no response'
    },
    metadata: {
      tone: 'professional',
      isTemplate: true,
      generatedAt: new Date().toISOString()
    }
  };
}

export {
  buildPropertyContext,
  buildOwnerContext,
  buildBuyerContext,
  buildOfferContext
};
