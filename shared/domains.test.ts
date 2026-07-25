import { describe, it, expect } from 'vitest';
import { classifyDomains, drivingDomains, DOMAINS } from './domains.js';

describe('classifyDomains', () => {
  it('tags an AMOC threshold as ocean (and picks up climate framing)', () => {
    const d = classifyDomains(
      'Atlantic Meridional Overturning Circulation collapse',
      'Freshwater from Greenland melt is weakening the ocean circulation.',
    );
    expect(d).toContain('ocean');
  });

  it('tags deforestation as forest', () => {
    expect(classifyDomains('Amazon rainforest dieback', 'accelerating deforestation')).toContain(
      'forest',
    );
  });

  it('tags clean energy as climate (the upstream driver)', () => {
    expect(classifyDomains('Record clean energy deployment', 'solar and wind additions')).toContain(
      'climate',
    );
  });

  it('returns empty for text with no domain keywords', () => {
    expect(classifyDomains('An abstract statement about nothing in particular')).toEqual([]);
  });

  it('can return multiple domains and stays in DOMAINS order', () => {
    const d = classifyDomains('emissions drive ocean acidification and coral loss');
    expect(d).toEqual(d.filter((x) => DOMAINS.includes(x)));
    expect(d).toContain('climate');
    expect(d).toContain('ocean');
    // climate precedes ocean in DOMAINS
    expect(d.indexOf('climate')).toBeLessThan(d.indexOf('ocean'));
  });
});

describe('drivingDomains', () => {
  it('adds climate as an upstream driver of an ocean threshold', () => {
    const driving = drivingDomains(['ocean']);
    expect(driving.has('ocean')).toBe(true);
    expect(driving.has('climate')).toBe(true); // climate drives ocean
  });

  it('does not add climate for a non-Earth-system domain', () => {
    const driving = drivingDomains(['society']);
    expect(driving.has('society')).toBe(true);
    expect(driving.has('climate')).toBe(false);
  });

  it('a climate threshold drives only itself (no self-loop expansion)', () => {
    const driving = drivingDomains(['climate']);
    expect([...driving]).toEqual(['climate']);
  });
});
