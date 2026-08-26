import { describe, expect, it } from 'vitest';
import {
  propertyHasOwnerRentalEvidence,
  readStoredUseType,
  resolvePropertyUseType,
  shouldShowRentalWorkspace,
} from '../propertyUse';

describe('property use type', () => {
  it('does not invent a stored use type when the field is missing', () => {
    expect(readStoredUseType({ address: '11822 Prestwick Rd' })).toBeNull();
  });

  it('reads use type from financials and property_data.summary', () => {
    expect(readStoredUseType({ financials: { useType: 'rental' } })).toBe('long_term_rental');
    expect(readStoredUseType({
      property_data: { summary: { useType: 'long_term_rental' } },
    })).toBe('long_term_rental');
  });

  it('does not treat ATTOM rental AVM as owner rental evidence', () => {
    const property = {
      address: '11822 Prestwick Rd',
      property_data: { summary: { rental_avm: 4200, market_rent: 4200 } },
    };
    expect(propertyHasOwnerRentalEvidence(property)).toBe(false);
    expect(shouldShowRentalWorkspace(property)).toBe(false);
    expect(resolvePropertyUseType(property)).toBe('second_home');
  });

  it('shows rental analytics when owner-saved monthly rent exists, even if tagged second home', () => {
    const prestwick = {
      address: '11822 Prestwick Rd',
      property_data: { summary: { useType: 'second_home', rental_avm: 4200 } },
      financial_data: { monthlyRent: 3900 },
    };
    expect(propertyHasOwnerRentalEvidence(prestwick)).toBe(true);
    expect(shouldShowRentalWorkspace(prestwick)).toBe(true);
    expect(resolvePropertyUseType(prestwick)).toBe('second_home');
  });

  it('infers a long-term rental when use type was never stored but rent was', () => {
    const prestwick = {
      address: '11822 Prestwick Rd',
      financials: { monthlyRent: 3900 },
    };
    expect(resolvePropertyUseType(prestwick)).toBe('long_term_rental');
    expect(shouldShowRentalWorkspace(prestwick)).toBe(true);
  });

  it('shows rental analytics when a current tenant is on file', () => {
    expect(shouldShowRentalWorkspace(
      { address: '11822 Prestwick Rd', property_data: { summary: { useType: 'second_home' } } },
      { occupied: true },
    )).toBe(true);
  });

  it('keeps analytics hidden for an explicit second home with no rent or tenant', () => {
    const property = {
      address: '11822 Prestwick Rd',
      property_data: { summary: { useType: 'second_home' } },
    };
    expect(shouldShowRentalWorkspace(property)).toBe(false);
  });
});
