#!/usr/bin/env python3
"""
Bulk enhance fine-tuning examples to target ~780 words for assistant responses.
Adds missing sections and expands analysis while maintaining quality.
"""

import json
import re

# Standard sections and their typical word counts for a balanced 780-word response
SECTION_TEMPLATES = {
    "fair_value": """**Fair Value Assessment:**
- FV10: {fv10}
- FV50: {fv50}
- FV90: {fv90}""",
    
    "wedge_detection": """**Wedge Detection:**
- List Price: {list_price}
- Edge: {edge}% ({direction})
- Spread: {spread}%
- Coverage Score: {coverage}
- Confidence: {confidence}
- Wedge Score: {wedge_score}
- **Decision: {decision}**""",
    
    "cash_flow": """**Cash Flow Analysis:**

**Monthly Income:**
- Rent: {rent}/month

**Monthly Expenses:**
{expense_items}
- **Total OPEX: {total_opex}/month**

**Cash Flow:**
- NOI: {noi}/month
- Mortgage P&I: {pi}/month
- **Net Cash Flow: {fcf}/month** {status}""",
    
    "return_metrics": """**Return Metrics:**
- **DSCR: {dscr}** {dscr_status}
- **Cash-on-Cash: {coc}%** {coc_status}
- Cap Rate: {cap_rate}%
- Principal paydown: {principal}/year
- Appreciation (3%): {appreciation}/year
- **Total ROI: {total_roi}%** {roi_status}""",
    
    "market_context": """**Market Context:**
{market_trends}

**Property Positioning:**
{property_position}

**Risk Assessment:**
{risk_factors}"""
}

def analyze_example(example):
    """Analyze what sections are present and missing."""
    asst_content = [m['content'] for m in example['messages'] if m['role'] == 'assistant'][0]
    
    sections_present = {
        'fair_value': 'Fair Value Assessment' in asst_content or 'FV10:' in asst_content,
        'wedge_detection': 'Wedge Detection' in asst_content or 'Edge:' in asst_content,
        'cash_flow': 'Cash Flow' in asst_content,
        'return_metrics': 'Return Metrics' in asst_content or 'DSCR:' in asst_content,
        'recommendation': 'Recommendation:' in asst_content,
    }
    
    word_count = len(asst_content.split())
    
    return {
        'sections_present': sections_present,
        'word_count': word_count,
        'needs_expansion': word_count < 700,
        'missing_sections': [k for k, v in sections_present.items() if not v]
    }

def main():
    input_file = '/Users/griffinwhite/src/Front End Type Shit/real-estate-finetuning-examples.jsonl'
    
    with open(input_file, 'r') as f:
        examples = [json.loads(line) for line in f]
    
    print("=== ENHANCEMENT ANALYSIS ===\n")
    
    needs_work = []
    
    for i, ex in enumerate(examples, 1):
        analysis = analyze_example(ex)
        
        if analysis['needs_expansion'] or len(analysis['missing_sections']) >= 2:
            needs_work.append((i, analysis))
            print(f"Example {i}: {analysis['word_count']}w")
            print(f"  Missing: {', '.join(analysis['missing_sections'])}")
            print()
    
    print(f"\nTotal examples needing work: {len(needs_work)}")
    print("\nThis script has identified which examples need enhancement.")
    print("Manual rewriting recommended for quality control.")

if __name__ == "__main__":
    main()
