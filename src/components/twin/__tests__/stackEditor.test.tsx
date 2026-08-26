/**
 * Every field on this form changes what the twin will claim about a specific
 * apartment after a leak, so the assertions are about the claims, not the markup:
 * that the risk-widening options are opt-in, that the shared-wall question is
 * only asked when it can be true, and that the count shown is the count the
 * drawing will produce.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import StackEditor, { StackGuessBanner, SwitchToBuildingBanner } from '../StackEditor';
import { DEFAULT_BUILDING_SPEC, type BuildingSpec } from '../buildingModel';

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  ...DEFAULT_BUILDING_SPEC,
  floors: 3,
  unitsPerFloor: 4,
  archetype: 'garden_walkup',
  ...over,
});

const render = (over: Partial<BuildingSpec> = {}, confirmed = false) =>
  renderToStaticMarkup(
    <StackEditor
      spec={spec(over)}
      confirmed={confirmed}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  );

describe('StackEditor', () => {
  it('asks for confirmation before it has been confirmed', () => {
    const html = render();
    expect(html).toContain('Is this building right?');
    expect(html).toContain("Yes, that&#x27;s right");
  });

  it('turns into a plain editor once confirmed', () => {
    const html = render({}, true);
    expect(html).toContain('Stacking plan');
    expect(html).not.toContain('Is this building right?');
    expect(html).toContain('Save changes');
  });

  it('says where the guess came from and why correcting it matters', () => {
    // A prompt that does not explain itself gets dismissed.
    const html = render();
    expect(html).toContain('property records');
    expect(html).toContain('name specific apartments');
  });

  it('shows the unit count the drawing will actually produce', () => {
    // Built rather than multiplied out, so a mirrored far side is included.
    expect(render({ floors: 3, unitsPerFloor: 4, corridor: 'none' })).toContain('12 units in total');
    expect(render({ floors: 3, unitsPerFloor: 4, corridor: 'double_loaded' }))
      .toContain('24 units in total');
  });

  it('mentions the basement in the count when there is one', () => {
    expect(render({ hasBasement: true })).toContain('plus a basement');
    expect(render({ hasBasement: false })).not.toContain('plus a basement');
  });

  it('only asks about a shared wet wall when there is a hall to share it across', () => {
    // In a walk-up there is no unit across the corridor, so the question has no
    // answer and asking it invites a wrong one.
    expect(render({ corridor: 'none' })).not.toContain('back onto each other');
    expect(render({ corridor: 'double_loaded' })).toContain('back onto each other');
  });

  it('describes the shared wall as a manager would see it', () => {
    // They are being asked whether the plumbing is in the wall between two
    // apartments, not to agree with the phrase "shared risers".
    const html = render({ corridor: 'double_loaded' });
    expect(html).toContain('unit across the hall in scope');
  });

  it('bounds the steppers, so a typo cannot ask for fifty thousand units', () => {
    const html = render();
    expect(html).toContain('max="60"');
    expect(html).toContain('max="40"');
  });

  it('shows a persist error instead of failing silently', () => {
    const html = renderToStaticMarkup(
      <StackEditor
        spec={spec()}
        confirmed
        error="Could not save the stacking plan (Firestore unavailable). The building view is still using what you entered."
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('Could not save the stacking plan');
    expect(html).toContain('still using what you entered');
  });

  it('offers both layouts with a description of each', () => {
    const html = render();
    expect(html).toContain('One row of units');
    expect(html).toContain('Units on both sides');
    expect(html).toContain('exterior breezeway');
  });
});

describe('SwitchToBuildingBanner', () => {
  it('offers to switch the house drawing to a building', () => {
    const html = renderToStaticMarkup(
      <SwitchToBuildingBanner onEdit={() => {}} />,
    );
    expect(html).toContain('if this is apartments');
    expect(html).toContain('switch to a building view');
  });
});

describe('StackGuessBanner', () => {
  it('states the guess and how to fix it, like the device pins do', () => {
    const html = renderToStaticMarkup(
      <StackGuessBanner spec={spec({ floors: 5, unitsPerFloor: 8 })} onEdit={() => {}} />,
    );

    expect(html).toContain('5 floors, 8 units per floor is a guess');
    expect(html).toContain('confirm or correct');
    // Same amber as "placed by guess", so the convention is learned once.
    expect(html).toContain('amber');
  });
});
