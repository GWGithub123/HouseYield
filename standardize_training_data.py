#!/usr/bin/env python3
"""
Standardize fine-tuning examples to consistent length and depth.
Target: ~80-90 word user inputs, ~750-800 word assistant responses
"""

import json

# Read the original file
input_file = '/Users/griffinwhite/src/Front End Type Shit/real-estate-finetuning-examples.jsonl'
output_file = '/Users/griffinwhite/src/Front End Type Shit/real-estate-finetuning-examples-standardized.jsonl'

with open(input_file, 'r') as f:
    examples = [json.loads(line) for line in f]

# Target lengths
TARGET_USER_WORDS = 85
TARGET_ASSISTANT_WORDS = 780
TOLERANCE = 0.15  # 15% tolerance

standardized = []

for i, example in enumerate(examples, 1):
    messages = example['messages']
    
    user_msg = [m for m in messages if m['role'] == 'user'][0]
    asst_msg = [m for m in messages if m['role'] == 'assistant'][0]
    
    user_words = len(user_msg['content'].split())
    asst_words = len(asst_msg['content'].split())
    
    user_deviation = abs(user_words - TARGET_USER_WORDS) / TARGET_USER_WORDS
    asst_deviation = abs(asst_words - TARGET_ASSISTANT_WORDS) / TARGET_ASSISTANT_WORDS
    
    # Examples that need adjustment
    if user_deviation > TOLERANCE or asst_deviation > TOLERANCE:
        print(f"Example {i}: User={user_words}w (target {TARGET_USER_WORDS}), Asst={asst_words}w (target {TARGET_ASSISTANT_WORDS})")
        print(f"  User deviation: {user_deviation*100:.1f}%, Asst deviation: {asst_deviation*100:.1f}%")
    
    standardized.append(example)

# Report statistics
print(f"\nExamples needing adjustment: {sum(1 for ex in examples if abs(len([m for m in ex['messages'] if m['role'] == 'assistant'][0]['content'].split()) - TARGET_ASSISTANT_WORDS) / TARGET_ASSISTANT_WORDS > TOLERANCE)}")
print(f"Total examples: {len(examples)}")

# Write standardized version (for now, just copy - will manually adjust the problematic ones)
with open(output_file, 'w') as f:
    for ex in standardized:
        f.write(json.dumps(ex) + '\n')

print(f"\nWrote standardized file to: {output_file}")
