/**
 * Visual AI Service - GPT-4 Vision Analysis
 * Analyzes property photos to assess condition, identify issues, and estimate renovation needs
 */

import { requestAiChatCompletion } from './aiChatProxy';
import { createEmptyCanonicalVisualEvidence, extractCanonicalVisualEvidence } from './visualEvidenceService';
import type { CanonicalVisualEvidence } from '../types/renovationPipeline';

export interface VisualAIAnalysis {
  exterior: {
    roof: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      material: string;
      age_estimate: number;
      issues: string[];
    };
    siding: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      material: string;
      issues: string[];
    };
    windows: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      style: string;
      issues: string[];
    };
    doors: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      issues: string[];
    };
    foundation: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      issues: string[];
    };
    driveway: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      material: string;
      issues: string[];
    };
    landscaping: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      notes: string;
    };
  };
  interior: {
    kitchen: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      appliances: 'modern' | 'updated' | 'dated' | 'old';
      cabinets: 'excellent' | 'good' | 'fair' | 'poor';
      countertops: string;
      flooring: string;
      issues: string[];
    };
    bathrooms: {
      master?: {
        condition: 'excellent' | 'good' | 'fair' | 'poor';
        fixtures: 'modern' | 'updated' | 'dated' | 'old';
        issues: string[];
      };
      secondary?: Array<{
        condition: 'excellent' | 'good' | 'fair' | 'poor';
        fixtures: 'modern' | 'updated' | 'dated' | 'old';
        issues: string[];
      }>;
    };
    bedrooms: {
      master?: {
        condition: 'excellent' | 'good' | 'fair' | 'poor';
        flooring: string;
        issues: string[];
      };
      secondary?: Array<{
        condition: 'excellent' | 'good' | 'fair' | 'poor';
        flooring: string;
        issues: string[];
      }>;
    };
    living_room: {
      condition: 'excellent' | 'good' | 'fair' | 'poor';
      flooring: string;
      issues: string[];
    };
  };
  systems: {
    hvac: {
      visible_condition: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
      age_estimate?: number;
      issues: string[];
    };
    electrical: {
      visible_condition: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
      issues: string[];
    };
    plumbing: {
      visible_condition: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
      issues: string[];
    };
  };
  qualitative: {
    overall_appeal: 1 | 2 | 3 | 4 | 5;
    cleanliness: 1 | 2 | 3 | 4 | 5;
    modernization_level: 1 | 2 | 3 | 4 | 5;
    natural_light: 1 | 2 | 3 | 4 | 5;
    layout_efficiency: 1 | 2 | 3 | 4 | 5;
    overall_notes: string;
  };
  renovation_opportunities?: Array<{
    area: string;
    description: string;
    estimated_cost_range: string;
    value_add_potential: 'high' | 'medium' | 'low';
    rent_increase_potential: string;
    priority: 'immediate' | 'short-term' | 'long-term';
    roi_estimate: string;
  }>;
  canonicalEvidence?: CanonicalVisualEvidence;
}

const ANALYSIS_PROMPT = `You are an expert real estate property inspector analyzing property photos to provide detailed condition assessments for investment analysis.

Analyze ALL provided photos and return a comprehensive JSON assessment with the following structure:

{
  "exterior": {
    "roof": {
      "condition": "excellent|good|fair|poor",
      "material": "asphalt shingles|metal|tile|etc",
      "age_estimate": number (years),
      "issues": ["list specific visible issues"]
    },
    "siding": {
      "condition": "excellent|good|fair|poor",
      "material": "vinyl|wood|brick|stucco|etc",
      "issues": ["list specific issues"]
    },
    "windows": {
      "condition": "excellent|good|fair|poor",
      "style": "double-hung|casement|slider|etc",
      "issues": ["broken seals, rot, damage, etc"]
    },
    "doors": {
      "condition": "excellent|good|fair|poor",
      "issues": ["damage, rot, hardware issues"]
    },
    "foundation": {
      "condition": "excellent|good|fair|poor",
      "issues": ["cracks, settling, water damage"]
    },
    "driveway": {
      "condition": "excellent|good|fair|poor",
      "material": "concrete|asphalt|gravel|pavers",
      "issues": ["cracks, deterioration"]
    },
    "landscaping": {
      "condition": "excellent|good|fair|poor",
      "notes": "describe overall landscape condition"
    }
  },
  "interior": {
    "kitchen": {
      "condition": "excellent|good|fair|poor",
      "appliances": "modern|updated|dated|old",
      "cabinets": "excellent|good|fair|poor",
      "countertops": "granite|quartz|laminate|tile|etc",
      "flooring": "hardwood|tile|vinyl|laminate|carpet",
      "issues": ["outdated fixtures, damage, wear"]
    },
    "bathrooms": {
      "master": {
        "condition": "excellent|good|fair|poor",
        "fixtures": "modern|updated|dated|old",
        "issues": ["grout damage, fixtures, water damage"]
      },
      "secondary": [
        {
          "condition": "excellent|good|fair|poor",
          "fixtures": "modern|updated|dated|old",
          "issues": ["list issues"]
        }
      ]
    },
    "bedrooms": {
      "master": {
        "condition": "excellent|good|fair|poor",
        "flooring": "hardwood|carpet|etc",
        "issues": ["damage, wear, outdated"]
      },
      "secondary": [
        {
          "condition": "excellent|good|fair|poor",
          "flooring": "type",
          "issues": ["list issues"]
        }
      ]
    },
    "living_room": {
      "condition": "excellent|good|fair|poor",
      "flooring": "hardwood|carpet|etc",
      "issues": ["damage, wear"]
    }
  },
  "systems": {
    "hvac": {
      "visible_condition": "excellent|good|fair|poor|unknown",
      "age_estimate": number (years, if visible),
      "issues": ["visible issues with vents, units"]
    },
    "electrical": {
      "visible_condition": "excellent|good|fair|poor|unknown",
      "issues": ["outdated outlets, visible wiring issues"]
    },
    "plumbing": {
      "visible_condition": "excellent|good|fair|poor|unknown",
      "issues": ["leaks, corrosion, old fixtures"]
    }
  },
  "qualitative": {
    "overall_appeal": 1-5 (curb appeal and interior presentation),
    "cleanliness": 1-5,
    "modernization_level": 1-5 (1=very dated, 5=newly renovated),
    "natural_light": 1-5,
    "layout_efficiency": 1-5 (based on visible flow),
    "overall_notes": "comprehensive summary of property condition"
  },
  "renovation_opportunities": [
    {
      "area": "Kitchen|Bathroom|Exterior|etc",
      "description": "Specific improvement opportunity based on what you see",
      "estimated_cost_range": "$X,XXX - $XX,XXX",
      "value_add_potential": "high|medium|low",
      "rent_increase_potential": "$XXX/month",
      "priority": "immediate|short-term|long-term",
      "roi_estimate": "XX% return on investment"
    }
  ]
}

GRADING SCALE:
- excellent: Like new, no visible issues
- good: Well maintained, minor wear expected for age
- fair: Functional but showing age, needs updates soon
- poor: Significant issues, needs immediate attention/replacement

RENOVATION OPPORTUNITIES:
Identify specific value-add renovation opportunities based on what you observe in the photos. Focus on:
1. Cosmetic updates that significantly improve appeal (paint, fixtures, lighting)
2. Kitchen/bathroom updates with high ROI
3. Curb appeal improvements
4. Modernization opportunities (dated fixtures, appliances, finishes)
5. Layout improvements if visible
6. Energy efficiency upgrades if systems appear dated

For each opportunity, provide realistic cost estimates and potential value/rent increases based on typical market impacts.

Be thorough and specific. If you cannot see a particular element in the photos, mark condition as "unknown" and leave issues empty.
Focus on investment-relevant observations: deferred maintenance, value-add opportunities, and major concerns.

Return ONLY valid JSON, no additional text.`;

/**
 * Analyze property photos using GPT-4 Vision
 */
export async function analyzePropertyPhotos(
  photoBase64Array: string[]
): Promise<VisualAIAnalysis> {
  if (!photoBase64Array || photoBase64Array.length === 0) {
    console.warn('[VisualAI] No photos provided');
    const defaultAnalysis = getDefaultAnalysis();
    defaultAnalysis.canonicalEvidence = createEmptyCanonicalVisualEvidence(
      0,
      'unavailable',
      'No photos were provided for legacy or canonical visual analysis.'
    );
    return defaultAnalysis;
  }

  const canonicalEvidencePromise = extractCanonicalVisualEvidence(photoBase64Array).catch((error: any) => {
    console.warn('[VisualAI] Canonical visual evidence extraction failed:', error?.message || error);
    return createEmptyCanonicalVisualEvidence(
      photoBase64Array.length,
      'partial',
      error?.message || 'Canonical visual evidence extraction failed.'
    );
  });

  try {
    console.log(`[VisualAI] Analyzing ${photoBase64Array.length} photos with GPT-4 Vision...`);

    // Prepare image content for vision API
    const imageContent = photoBase64Array.map(base64 => ({
      type: 'image_url' as const,
      image_url: {
        url: base64,
        detail: 'high' as const
      }
    }));

    const data = await requestAiChatCompletion({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: ANALYSIS_PROMPT
            },
            ...imageContent
          ]
        }
      ],
      max_tokens: 4096,
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    let content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No response content from OpenAI');
    }

    console.log('[VisualAI] Raw response:', content);

    // Strip markdown code blocks if present (```json ... ```)
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Parse JSON response
    const analysis = JSON.parse(content) as VisualAIAnalysis;
    analysis.canonicalEvidence = await canonicalEvidencePromise;
    
    console.log('[VisualAI] Analysis complete:', {
      exteriorCondition: analysis.exterior.roof.condition,
      kitchenCondition: analysis.interior.kitchen.condition,
      overallAppeal: analysis.qualitative.overall_appeal,
      canonicalFindings: analysis.canonicalEvidence.summary.findingCount,
      canonicalOpportunities: analysis.canonicalEvidence.summary.opportunityCount,
    });

    return analysis;

  } catch (err) {
    console.error('[VisualAI] Error analyzing photos:', err);
    const defaultAnalysis = getDefaultAnalysis();
    defaultAnalysis.canonicalEvidence = await canonicalEvidencePromise;
    return defaultAnalysis;
  }
}

/**
 * Returns a default "unknown" analysis when photos can't be analyzed
 */
function getDefaultAnalysis(): VisualAIAnalysis {
  return {
    exterior: {
      roof: {
        condition: 'good',
        material: 'unknown',
        age_estimate: 15,
        issues: []
      },
      siding: {
        condition: 'good',
        material: 'unknown',
        issues: []
      },
      windows: {
        condition: 'good',
        style: 'unknown',
        issues: []
      },
      doors: {
        condition: 'good',
        issues: []
      },
      foundation: {
        condition: 'good',
        issues: []
      },
      driveway: {
        condition: 'good',
        material: 'unknown',
        issues: []
      },
      landscaping: {
        condition: 'good',
        notes: 'No photos provided'
      }
    },
    interior: {
      kitchen: {
        condition: 'good',
        appliances: 'updated',
        cabinets: 'good',
        countertops: 'unknown',
        flooring: 'unknown',
        issues: []
      },
      bathrooms: {
        master: {
          condition: 'good',
          fixtures: 'updated',
          issues: []
        },
        secondary: []
      },
      bedrooms: {
        master: {
          condition: 'good',
          flooring: 'unknown',
          issues: []
        },
        secondary: []
      },
      living_room: {
        condition: 'good',
        flooring: 'unknown',
        issues: []
      }
    },
    systems: {
      hvac: {
        visible_condition: 'unknown',
        issues: []
      },
      electrical: {
        visible_condition: 'unknown',
        issues: []
      },
      plumbing: {
        visible_condition: 'unknown',
        issues: []
      }
    },
    qualitative: {
      overall_appeal: 3,
      cleanliness: 3,
      modernization_level: 3,
      natural_light: 3,
      layout_efficiency: 3,
      overall_notes: 'Analysis based on market data only - no photos analyzed'
    }
  };
}
