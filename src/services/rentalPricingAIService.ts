/**
 * Rental Pricing AI Analysis Service
 * Provides AI-powered analysis of rental pricing dynamics comparing user's
 * current rent to market rates, considering property condition and
 * recommending strategies for optimization.
 */

import { requestAiChatCompletion } from './aiChatProxy';

export interface RentalPricingContext {
  // Current property rental situation
  currentRent: number;
  marketPotentialRent: number;
  marketAverage: number;
  
  // Property details
  bedrooms: number;
  bathrooms: number;
  squareFeet: number;
  propertyAddress?: string;
  zipCode?: string;
  
  // Property condition (from photos or AI assessment)
  conditionScore?: number; // 0-100
  conditionGrade?: string; // A, B, C, D, F
  conditionNotes?: string[];
  hasRecentRenovations?: boolean;
  
  // Financial metrics
  monthlyExpenses?: number;
  monthlyMortgage?: number;
  currentCashFlow?: number;
  vacancyRate?: number;
  
  // Renovation data
  availableRenovations?: RenovationOption[];
  
  // Market comparables
  comparableRents?: number[];
  percentileRank?: number;
}

export interface RenovationOption {
  name: string;
  cost: number;
  rentIncrease: number;
  roi: number;
  paybackMonths: number;
}

export interface RentalPricingAnalysis {
  summary: string;
  situation: 'above_market' | 'at_market' | 'below_market';
  situationSeverity: 'significant' | 'moderate' | 'slight';
  
  // Detailed analysis sections
  marketComparison: {
    explanation: string;
    percentDifference: number;
    dollarDifference: number;
    marketPosition: string;
  };
  
  conditionAssessment?: {
    explanation: string;
    justifiesCurrentRent: boolean;
    conditionVsRentAlignment: string;
  };
  
  risks?: {
    title: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
  }[];
  
  opportunities?: {
    title: string;
    description: string;
    potentialImpact: string;
  }[];
  
  financialImpact: {
    currentMonthlyCashFlow: number;
    potentialMonthlyCashFlow: number;
    annualDifference: number;
    fiveYearImpact: number;
    explanation: string;
  };
  
  recommendations: {
    primary: string;
    actions: {
      action: string;
      impact: string;
      priority: 'immediate' | 'short-term' | 'long-term';
    }[];
    suggestedRenovations?: {
      name: string;
      cost: number;
      rentJustification: number;
      reason: string;
    }[];
  };
  
  // For displaying in UI
  insightCards: {
    icon: string;
    title: string;
    value: string;
    subtext: string;
    color: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
  }[];
}

/**
 * Analyze rental pricing dynamics with AI
 */
export async function analyzeRentalPricing(
  context: RentalPricingContext
): Promise<RentalPricingAnalysis> {
  const percentDifference = ((context.currentRent - context.marketPotentialRent) / context.marketPotentialRent) * 100;
  const dollarDifference = context.currentRent - context.marketPotentialRent;
  
  // Determine situation
  let situation: RentalPricingAnalysis['situation'];
  let situationSeverity: RentalPricingAnalysis['situationSeverity'];
  
  if (percentDifference > 15) {
    situation = 'above_market';
    situationSeverity = 'significant';
  } else if (percentDifference > 5) {
    situation = 'above_market';
    situationSeverity = 'moderate';
  } else if (percentDifference > 0) {
    situation = 'above_market';
    situationSeverity = 'slight';
  } else if (percentDifference < -15) {
    situation = 'below_market';
    situationSeverity = 'significant';
  } else if (percentDifference < -5) {
    situation = 'below_market';
    situationSeverity = 'moderate';
  } else if (percentDifference < 0) {
    situation = 'below_market';
    situationSeverity = 'slight';
  } else {
    situation = 'at_market';
    situationSeverity = 'slight';
  }
  
  // Try AI-powered analysis first
  try {
    return await getAIAnalysis(context, situation, situationSeverity, percentDifference, dollarDifference);
  } catch (error) {
    console.warn('[RentalPricingAI] AI analysis failed, falling back to rule-based:', error);
  }
  
  // Fallback to rule-based analysis
  return generateRuleBasedAnalysis(context, situation, situationSeverity, percentDifference, dollarDifference);
}

/**
 * Get AI-powered rental pricing analysis using GPT-4
 */
async function getAIAnalysis(
  context: RentalPricingContext,
  situation: RentalPricingAnalysis['situation'],
  situationSeverity: RentalPricingAnalysis['situationSeverity'],
  percentDifference: number,
  dollarDifference: number
): Promise<RentalPricingAnalysis> {
  const prompt = buildAnalysisPrompt(context, situation, percentDifference, dollarDifference);
  
  const data = await requestAiChatCompletion({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an expert real estate investment advisor specializing in rental property optimization. 
Analyze rental pricing dynamics and provide actionable insights. Be specific with numbers and recommendations.
Always consider the relationship between property condition, rental rates, tenant quality, and cash flow.
Format your response as a JSON object matching the RentalPricingAnalysis interface.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: 1500,
    response_format: { type: 'json_object' }
  });

  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error('No response content from OpenAI');
  }
  
  const aiAnalysis = JSON.parse(content);
  
  // Merge AI analysis with calculated values
  return {
    ...aiAnalysis,
    situation,
    situationSeverity,
    marketComparison: {
      ...aiAnalysis.marketComparison,
      percentDifference,
      dollarDifference
    }
  };
}

/**
 * Build the analysis prompt for GPT-4
 */
function buildAnalysisPrompt(
  context: RentalPricingContext,
  situation: string,
  percentDifference: number,
  dollarDifference: number
): string {
  const currentCashFlow = context.currentCashFlow ?? 
    (context.currentRent - (context.monthlyExpenses || 0) - (context.monthlyMortgage || 0));
  
  let renovationContext = '';
  if (context.availableRenovations && context.availableRenovations.length > 0) {
    renovationContext = `
Available Renovations (sorted by ROI):
${context.availableRenovations.slice(0, 5).map(r => 
  `- ${r.name}: $${r.cost} cost, +$${r.rentIncrease}/mo rent increase, ${r.roi.toFixed(0)}% ROI, ${r.paybackMonths} month payback`
).join('\n')}
`;
  }
  
  let conditionContext = '';
  if (context.conditionScore !== undefined || context.conditionGrade) {
    conditionContext = `
Property Condition:
- Score: ${context.conditionScore || 'Unknown'}/100
- Grade: ${context.conditionGrade || 'Unknown'}
${context.conditionNotes?.length ? `- Notes: ${context.conditionNotes.join(', ')}` : ''}
${context.hasRecentRenovations ? '- Has recent renovations' : ''}
`;
  }
  
  return `Analyze this rental property's pricing dynamics:

**Current Situation: ${situation.replace('_', ' ').toUpperCase()}**

Property Details:
- Address: ${context.propertyAddress || 'Not specified'} (${context.zipCode || 'Unknown ZIP'})
- Size: ${context.squareFeet} sq ft, ${context.bedrooms} bed / ${context.bathrooms} bath

Rental Pricing:
- Current Rent: $${context.currentRent}/month
- Market Potential: $${context.marketPotentialRent}/month
- Market Average: $${context.marketAverage}/month
- Difference: ${percentDifference > 0 ? '+' : ''}${percentDifference.toFixed(1)}% ($${Math.abs(dollarDifference)}/mo ${dollarDifference > 0 ? 'above' : 'below'} market)
${context.percentileRank !== undefined ? `- Percentile Rank: ${context.percentileRank}th percentile` : ''}

Financial Metrics:
- Monthly Expenses: $${context.monthlyExpenses || 'Unknown'}
- Monthly Mortgage: $${context.monthlyMortgage || 'Unknown'}
- Current Cash Flow: $${currentCashFlow}/month
- Vacancy Rate: ${context.vacancyRate || 5}%
${conditionContext}
${renovationContext}

Please provide a comprehensive analysis as JSON with:
1. "summary": A 2-3 sentence executive summary of the rental pricing situation
2. "marketComparison": { "explanation": string, "marketPosition": string describing where they stand }
3. "conditionAssessment": { "explanation": string, "justifiesCurrentRent": boolean, "conditionVsRentAlignment": string } - Assess if the property condition justifies the rent level
4. "risks": Array of { "title": string, "description": string, "severity": "high"|"medium"|"low" } - Key risks (e.g., turnover risk if rent is too high)
5. "opportunities": Array of { "title": string, "description": string, "potentialImpact": string } - Opportunities to optimize
6. "financialImpact": { "currentMonthlyCashFlow": number, "potentialMonthlyCashFlow": number, "annualDifference": number, "fiveYearImpact": number, "explanation": string }
7. "recommendations": { "primary": string (main recommendation), "actions": Array of { "action": string, "impact": string, "priority": "immediate"|"short-term"|"long-term" }, "suggestedRenovations": optional array of { "name": string, "cost": number, "rentJustification": number, "reason": string } }
8. "insightCards": Array of 3-4 cards { "icon": emoji, "title": string, "value": string, "subtext": string, "color": "green"|"yellow"|"red"|"blue"|"purple" }

Focus on actionable insights that help the property owner optimize their rental income while maintaining good tenant relationships.`;
}

/**
 * Generate rule-based analysis when AI is not available
 */
function generateRuleBasedAnalysis(
  context: RentalPricingContext,
  situation: RentalPricingAnalysis['situation'],
  situationSeverity: RentalPricingAnalysis['situationSeverity'],
  percentDifference: number,
  dollarDifference: number
): RentalPricingAnalysis {
  const currentCashFlow = context.currentCashFlow ?? 
    (context.currentRent - (context.monthlyExpenses || 0) - (context.monthlyMortgage || 0));
  
  let summary: string;
  let marketPosition: string;
  let marketExplanation: string;
  let risks: RentalPricingAnalysis['risks'] = [];
  let opportunities: RentalPricingAnalysis['opportunities'] = [];
  let primaryRecommendation: string;
  let actions: RentalPricingAnalysis['recommendations']['actions'] = [];
  let conditionAssessment: RentalPricingAnalysis['conditionAssessment'] | undefined;
  let insightCards: RentalPricingAnalysis['insightCards'] = [];
  
  const conditionJustifiesRent = context.conditionScore 
    ? (situation === 'above_market' ? context.conditionScore >= 70 : true)
    : undefined;
  
  if (situation === 'above_market') {
    // Rent is HIGHER than market
    if (situationSeverity === 'significant') {
      summary = `Your rent of $${context.currentRent}/mo is ${percentDifference.toFixed(0)}% above market rate ($${context.marketPotentialRent}/mo). This premium pricing ${conditionJustifiesRent ? 'may be justified by your property\'s condition' : 'could lead to tenant turnover issues'}.`;
      marketPosition = 'Premium pricing tier - significantly above comparable properties';
      
      risks = [
        {
          title: 'High Turnover Risk',
          description: `Tenants paying ${percentDifference.toFixed(0)}% above market may actively seek cheaper alternatives. Each vacancy costs approximately $${(context.currentRent * 1.5).toFixed(0)} in lost rent and turnover expenses.`,
          severity: 'high'
        },
        {
          title: 'Extended Vacancy Periods',
          description: 'At-market properties typically lease within 2-3 weeks, while premium-priced units may take 6+ weeks, reducing annual income.',
          severity: 'medium'
        }
      ];
      
      if (conditionJustifiesRent) {
        opportunities = [
          {
            title: 'Premium Positioning',
            description: 'Your property condition supports premium pricing. Maintain this advantage through proactive maintenance.',
            potentialImpact: `Justified premium of +$${dollarDifference}/mo ($${(dollarDifference * 12).toLocaleString()}/year)`
          }
        ];
        primaryRecommendation = 'Maintain property condition to justify premium pricing, but consider slight reduction if experiencing extended vacancies.';
      } else {
        opportunities = [
          {
            title: 'Condition Improvement',
            description: 'Strategic renovations could justify your current rent level and reduce turnover.',
            potentialImpact: 'Reduce vacancy risk while maintaining current income'
          }
        ];
        primaryRecommendation = 'Either reduce rent by $100-150/mo to align with market, or invest in renovations to justify the premium.';
      }
      
    } else if (situationSeverity === 'moderate') {
      summary = `Your rent is ${percentDifference.toFixed(0)}% above market ($${Math.abs(dollarDifference)}/mo premium). You're generating strong cash flow but should monitor tenant satisfaction.`;
      marketPosition = 'Above-market pricing - moderate premium over comparables';
      
      risks = [
        {
          title: 'Moderate Turnover Risk',
          description: 'Tenants are paying a noticeable premium. Ensure property condition and responsiveness justify the higher rate.',
          severity: 'medium'
        }
      ];
      
      opportunities = [
        {
          title: 'Strong Cash Flow Position',
          description: `Your premium pricing generates an additional $${dollarDifference}/mo ($${(dollarDifference * 12).toLocaleString()}/year) in cash flow.`,
          potentialImpact: 'Continue optimizing expenses to maximize returns'
        }
      ];
      
      primaryRecommendation = 'Current pricing is sustainable. Focus on tenant retention through excellent service and timely maintenance.';
      
    } else {
      summary = `Your rent is slightly above market (+${percentDifference.toFixed(0)}%). This is a healthy position that maximizes returns without significant turnover risk.`;
      marketPosition = 'Slightly above market - optimal pricing zone';
      primaryRecommendation = 'Maintain current pricing strategy. You\'re in the sweet spot between maximizing income and tenant retention.';
    }
    
    insightCards = [
      {
        icon: '💰',
        title: 'Monthly Premium',
        value: `+$${dollarDifference.toLocaleString()}`,
        subtext: 'Above market rate',
        color: situationSeverity === 'significant' ? 'yellow' : 'green'
      },
      {
        icon: '📊',
        title: 'Market Position',
        value: `${percentDifference.toFixed(0)}%`,
        subtext: 'Above comparable rents',
        color: situationSeverity === 'significant' ? 'yellow' : 'blue'
      },
      {
        icon: '🏠',
        title: 'Cash Flow',
        value: `$${currentCashFlow.toLocaleString()}/mo`,
        subtext: currentCashFlow > 0 ? 'Positive flow' : 'Negative flow',
        color: currentCashFlow > 0 ? 'green' : 'red'
      },
      {
        icon: situationSeverity === 'significant' ? '⚠️' : '✅',
        title: 'Risk Level',
        value: situationSeverity === 'significant' ? 'Elevated' : 'Low',
        subtext: 'Turnover risk assessment',
        color: situationSeverity === 'significant' ? 'yellow' : 'green'
      }
    ];
    
  } else if (situation === 'below_market') {
    // Rent is LOWER than market
    const potentialIncrease = Math.abs(dollarDifference);
    const potentialCashFlow = currentCashFlow + potentialIncrease;
    
    if (situationSeverity === 'significant') {
      summary = `You're leaving $${potentialIncrease}/mo on the table! Your rent is ${Math.abs(percentDifference).toFixed(0)}% below market. Raising rent to market rate would add $${(potentialIncrease * 12).toLocaleString()}/year to your cash flow.`;
      marketPosition = 'Significantly underpriced - major opportunity for income growth';
      
      opportunities = [
        {
          title: 'Significant Income Opportunity',
          description: `Raising rent to market rate ($${context.marketPotentialRent}/mo) would increase annual income by $${(potentialIncrease * 12).toLocaleString()}.`,
          potentialImpact: `+$${potentialIncrease}/mo cash flow`
        },
        {
          title: '5-Year Impact',
          description: `Over 5 years, market-rate pricing would generate an additional $${(potentialIncrease * 12 * 5).toLocaleString()} in cumulative income.`,
          potentialImpact: 'Substantial wealth building opportunity'
        }
      ];
      
      primaryRecommendation = `Implement a rent increase plan: Start with a $${Math.round(potentialIncrease * 0.6)}/mo increase at next lease renewal, then adjust to market over 12-18 months.`;
      
      actions = [
        {
          action: `Send rent increase notice ($${Math.round(potentialIncrease * 0.6)}/mo)`,
          impact: `Immediate +$${Math.round(potentialIncrease * 0.6)}/mo cash flow`,
          priority: 'immediate'
        },
        {
          action: 'Document property improvements for rent justification',
          impact: 'Supports rent increase communication to tenants',
          priority: 'immediate'
        },
        {
          action: `Adjust to full market rate ($${context.marketPotentialRent}/mo)`,
          impact: `Full +$${potentialIncrease}/mo cash flow`,
          priority: 'short-term'
        }
      ];
      
    } else if (situationSeverity === 'moderate') {
      summary = `Your rent is ${Math.abs(percentDifference).toFixed(0)}% below market. While this may provide tenant stability, you're missing $${potentialIncrease}/mo in potential income.`;
      marketPosition = 'Below market - moderate opportunity for optimization';
      
      opportunities = [
        {
          title: 'Income Optimization',
          description: `A rent adjustment to market rate would add $${potentialIncrease}/mo to your cash flow.`,
          potentialImpact: `+$${(potentialIncrease * 12).toLocaleString()}/year`
        }
      ];
      
      primaryRecommendation = `Consider a rent increase of $${Math.round(potentialIncrease * 0.8)}/mo at the next lease renewal to approach market rate.`;
      
    } else {
      summary = `Your rent is slightly below market (-${Math.abs(percentDifference).toFixed(0)}%). This conservative pricing likely contributes to good tenant retention.`;
      marketPosition = 'Slightly below market - stable tenant-friendly pricing';
      primaryRecommendation = 'Your pricing is reasonable. Consider a modest increase at next renewal to keep pace with market trends.';
    }
    
    insightCards = [
      {
        icon: '📉',
        title: 'Below Market',
        value: `-$${Math.abs(dollarDifference).toLocaleString()}`,
        subtext: 'Monthly opportunity cost',
        color: situationSeverity === 'significant' ? 'red' : 'yellow'
      },
      {
        icon: '💵',
        title: 'Potential Cash Flow',
        value: `$${potentialCashFlow.toLocaleString()}/mo`,
        subtext: 'At market rate',
        color: 'green'
      },
      {
        icon: '📈',
        title: '5-Year Impact',
        value: `+$${(potentialIncrease * 12 * 5).toLocaleString()}`,
        subtext: 'Cumulative additional income',
        color: 'blue'
      },
      {
        icon: '🎯',
        title: 'Market Rate',
        value: `$${context.marketPotentialRent.toLocaleString()}`,
        subtext: 'Target rent',
        color: 'purple'
      }
    ];
    
  } else {
    // At market rate
    summary = `Your rent of $${context.currentRent}/mo is right at market rate. You've found the optimal balance between maximizing income and minimizing vacancy risk.`;
    marketPosition = 'At market rate - optimal pricing achieved';
    primaryRecommendation = 'Maintain current pricing and focus on property improvements to command premium rates in the future.';
    
    opportunities = [
      {
        title: 'Consider Premium Positioning',
        description: 'Strategic improvements could allow you to command above-market rents.',
        potentialImpact: 'Potential 10-15% rent increase with targeted renovations'
      }
    ];
    
    insightCards = [
      {
        icon: '✅',
        title: 'Pricing Status',
        value: 'Optimal',
        subtext: 'At market rate',
        color: 'green'
      },
      {
        icon: '💰',
        title: 'Monthly Rent',
        value: `$${context.currentRent.toLocaleString()}`,
        subtext: 'Current rate',
        color: 'blue'
      },
      {
        icon: '🏠',
        title: 'Cash Flow',
        value: `$${currentCashFlow.toLocaleString()}/mo`,
        subtext: currentCashFlow > 0 ? 'Positive flow' : 'Needs attention',
        color: currentCashFlow > 0 ? 'green' : 'yellow'
      },
      {
        icon: '📊',
        title: 'Market Rank',
        value: `${context.percentileRank || 50}th`,
        subtext: 'Percentile',
        color: 'purple'
      }
    ];
  }
  
  // Condition assessment
  if (context.conditionScore !== undefined) {
    const conditionAlignment = getConditionAlignment(context.conditionScore, situation);
    conditionAssessment = {
      explanation: conditionAlignment.explanation,
      justifiesCurrentRent: conditionAlignment.justified,
      conditionVsRentAlignment: conditionAlignment.alignment
    };
  }
  
  // Suggested renovations
  let suggestedRenovations: RentalPricingAnalysis['recommendations']['suggestedRenovations'];
  if (context.availableRenovations && context.availableRenovations.length > 0) {
    suggestedRenovations = context.availableRenovations.slice(0, 3).map(r => ({
      name: r.name,
      cost: r.cost,
      rentJustification: r.rentIncrease,
      reason: situation === 'above_market' 
        ? `Justifies current premium with +$${r.rentIncrease}/mo value`
        : `Would allow +$${r.rentIncrease}/mo rent increase with ${r.paybackMonths} month payback`
    }));
  }
  
  // Financial impact calculation
  const potentialRent = situation === 'below_market' ? context.marketPotentialRent : context.currentRent;
  const potentialCashFlow = potentialRent - (context.monthlyExpenses || 0) - (context.monthlyMortgage || 0);
  const annualDifference = (potentialCashFlow - currentCashFlow) * 12;
  
  marketExplanation = `Your current rent of $${context.currentRent}/mo places you ${
    situation === 'above_market' ? `$${dollarDifference} above` : 
    situation === 'below_market' ? `$${Math.abs(dollarDifference)} below` : 
    'right at'
  } the market rate of $${context.marketPotentialRent}/mo for similar ${context.bedrooms}BR/${context.bathrooms}BA properties in your area.`;
  
  return {
    summary,
    situation,
    situationSeverity,
    marketComparison: {
      explanation: marketExplanation,
      percentDifference,
      dollarDifference,
      marketPosition
    },
    conditionAssessment,
    risks,
    opportunities,
    financialImpact: {
      currentMonthlyCashFlow: currentCashFlow,
      potentialMonthlyCashFlow: potentialCashFlow,
      annualDifference,
      fiveYearImpact: annualDifference * 5,
      explanation: situation === 'below_market'
        ? `Raising rent to market rate would increase your annual cash flow by $${annualDifference.toLocaleString()}.`
        : situation === 'above_market'
        ? `Your premium pricing generates $${(dollarDifference * 12).toLocaleString()}/year above market, but monitor vacancy costs.`
        : 'Your cash flow is optimized at current market-rate pricing.'
    },
    recommendations: {
      primary: primaryRecommendation,
      actions: actions.length > 0 ? actions : [
        {
          action: 'Review rent at next lease renewal',
          impact: 'Stay aligned with market trends',
          priority: 'short-term'
        },
        {
          action: 'Track comparable rental listings monthly',
          impact: 'Informed pricing decisions',
          priority: 'long-term'
        }
      ],
      suggestedRenovations
    },
    insightCards
  };
}

/**
 * Get condition vs rent alignment assessment
 */
function getConditionAlignment(
  conditionScore: number,
  situation: RentalPricingAnalysis['situation']
): { explanation: string; justified: boolean; alignment: string } {
  if (situation === 'above_market') {
    if (conditionScore >= 80) {
      return {
        explanation: 'Your property\'s excellent condition (A-grade) justifies the premium pricing. Tenants expect to pay more for well-maintained properties.',
        justified: true,
        alignment: 'Well aligned - premium condition supports premium rent'
      };
    } else if (conditionScore >= 60) {
      return {
        explanation: 'Your property is in good condition but the rent premium may be stretching what the market will bear. Consider targeted improvements.',
        justified: false,
        alignment: 'Moderate alignment - some improvements recommended'
      };
    } else {
      return {
        explanation: 'Property condition does not support the above-market rent. This mismatch significantly increases turnover risk.',
        justified: false,
        alignment: 'Poor alignment - condition upgrade or rent reduction needed'
      };
    }
  } else if (situation === 'below_market') {
    if (conditionScore >= 70) {
      return {
        explanation: 'Your property condition supports higher rent than you\'re currently charging. You\'re underselling your property.',
        justified: false,
        alignment: 'Underpriced - condition supports higher rent'
      };
    } else {
      return {
        explanation: 'The below-market rent aligns with the property\'s current condition. Improvements would justify rent increases.',
        justified: true,
        alignment: 'Aligned - rent matches condition'
      };
    }
  } else {
    return {
      explanation: 'Your rent and property condition are well balanced for the current market.',
      justified: true,
      alignment: 'Optimal alignment'
    };
  }
}

export default {
  analyzeRentalPricing
};
