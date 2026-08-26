import { describe, expect, it } from 'vitest';
import {
  buildChoiceQuestions,
  buildTriagePrompt,
  detectCategory,
  detectKnownFacts,
  normalizeChoiceQuestions,
} from '../../../../server/maintenance/triageQuestions.js';

describe('detectKnownFacts', () => {
  it('reads room and fixture out of a plain description', () => {
    const facts = detectKnownFacts('Theres a leak in the kitchen sink');
    expect(facts.room).toBe('Kitchen');
    expect(facts.fixture).toBe('sink');
    expect(facts.location).toBe('Kitchen sink');
  });

  it('leaves unstated details unknown', () => {
    const facts = detectKnownFacts('Theres a leak in the kitchen sink');
    expect(facts.severity).toBeNull();
    expect(facts.duration).toBeNull();
    expect(facts.damage).toBeNull();
  });

  it('grades severity from how the leak is described', () => {
    expect(detectKnownFacts('slow drip under the sink').severity).toBe('slow');
    expect(detectKnownFacts('water is pouring out').severity).toBe('severe');
  });

  it('picks up a fixture with no room named', () => {
    expect(detectKnownFacts('the water heater is making noise').location).toBe('Water heater');
  });
});

describe('buildChoiceQuestions', () => {
  it('never re-asks the room once a room was named', () => {
    const questions = buildChoiceQuestions({
      category: 'Plumbing',
      text: 'theres a leak in the kitchen sink',
    });
    expect(questions.map((q) => q.id)).not.toContain('room');
  });

  it('asks the room first when no location was given', () => {
    const questions = buildChoiceQuestions({ category: 'Plumbing', text: 'water everywhere' });
    expect(questions[0].id).toBe('room');
  });

  it('leads with concrete flow-rate choices for a leak', () => {
    const [first] = buildChoiceQuestions({
      category: 'Plumbing',
      text: 'theres a leak in the kitchen sink',
    });
    expect(first.id).toBe('flow_rate');
    expect(first.options.map((option) => option.label)).toEqual([
      'Slow drip',
      'Steady trickle',
      'Fast stream',
      'Pouring or spraying',
    ]);
  });

  it('drops questions the submitter already answered by tapping', () => {
    const questions = buildChoiceQuestions({
      category: 'Plumbing',
      text: 'theres a leak in the kitchen sink',
      answeredIds: ['flow_rate'],
    });
    expect(questions.map((q) => q.id)).not.toContain('flow_rate');
  });

  it('skips a question whose fact the submitter stated in prose', () => {
    const questions = buildChoiceQuestions({
      category: 'Plumbing',
      text: 'slow drip under the kitchen sink',
    });
    expect(questions.map((q) => q.id)).not.toContain('flow_rate');
  });

  it('caps the queue and always offers at least two options per question', () => {
    const questions = buildChoiceQuestions({ category: 'Plumbing', text: 'something is broken' });
    expect(questions.length).toBeLessThanOrEqual(3);
    for (const question of questions) {
      expect(question.options.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('normalizeChoiceQuestions', () => {
  it('keeps a well-formed model question and assigns option ids', () => {
    const [question] = normalizeChoiceQuestions([
      {
        id: 'Leak Severity',
        question: 'How fast is it leaking?',
        options: [{ label: 'Slow drip', detail: 'A few drops' }, { label: 'Pouring' }],
      },
    ]);
    expect(question.id).toBe('leak_severity');
    expect(question.options[0].id).toBe('leak_severity_0');
    expect(question.options[0].detail).toBe('A few drops');
  });

  it('accepts bare strings as options', () => {
    const [question] = normalizeChoiceQuestions([
      { id: 'q', question: 'Which one?', options: ['Yes', 'No'] },
    ]);
    expect(question.options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('drops questions that would render an unanswerable chip row', () => {
    expect(normalizeChoiceQuestions([
      { id: 'a', question: 'Only one choice?', options: ['Yes'] },
      { id: 'b', question: '', options: ['Yes', 'No'] },
      { id: 'c', question: 'No options?' },
    ])).toEqual([]);
  });

  it('removes duplicate option labels', () => {
    const [question] = normalizeChoiceQuestions([
      { id: 'q', question: 'Which?', options: ['Yes', 'yes', 'No'] },
    ]);
    expect(question.options).toHaveLength(2);
  });

  it('filters out questions already answered', () => {
    expect(normalizeChoiceQuestions(
      [{ id: 'flow_rate', question: 'How fast?', options: ['Slow', 'Fast'] }],
      { answeredIds: ['flow_rate'] },
    )).toEqual([]);
  });

  it('tolerates junk from the model', () => {
    expect(normalizeChoiceQuestions(null)).toEqual([]);
    expect(normalizeChoiceQuestions([null, 'nope', 42])).toEqual([]);
  });
});

describe('detectCategory', () => {
  it.each([
    ['theres a leak in the kitchen sink', 'Plumbing'],
    ['the outlet in the bedroom has no power', 'Electrical'],
    ['furnace wont turn on', 'HVAC'],
    ['dishwasher is making a noise', 'Appliances'],
    ['mice in the attic', 'Pest Control'],
    ['deadbolt wont lock', 'Lock/Security'],
    ['crack in the foundation', 'Structural'],
    ['something feels off', 'Other'],
  ])('maps %j to %s', (text, expected) => {
    expect(detectCategory(text)).toBe(expected);
  });
});

describe('buildTriagePrompt', () => {
  it('tells the model exactly which facts not to ask about again', () => {
    const prompt = buildTriagePrompt({
      speaker: 'owner',
      message: 'Theres a leak in the kitchen sink',
      knownFacts: detectKnownFacts('Theres a leak in the kitchen sink'),
      answeredIds: ['flow_rate'],
    });
    expect(prompt).toContain('location: Kitchen sink');
    expect(prompt).toContain('flow_rate');
    expect(prompt).toContain('Do not ask which room.');
  });

  it('does not tell an owner to contact their landlord', () => {
    const prompt = buildTriagePrompt({ speaker: 'owner', message: 'leak' });
    expect(prompt).toContain('Never tell them to contact their landlord');
  });

  it('omits the owner-only section for tenants', () => {
    const prompt = buildTriagePrompt({ speaker: 'tenant', message: 'leak' });
    expect(prompt).not.toContain('OWNER CONTEXT');
  });
});
