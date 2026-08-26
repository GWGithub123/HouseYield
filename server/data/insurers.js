// Carrier program information must be backed by a current primary-source page.
// Do not add guessed submission addresses or universal discount percentages:
// eligibility varies by state, underwriting company, policy form, and device.
export const insurers = [
  {
    id: 'state-farm',
    name: 'State Farm',
    logo: null,
    discountProgramName: 'Protective device eligibility varies by state',
    discountPercentage: 'Ask agent to confirm',
    submissionEmail: null,
    submissionPortalUrl: null,
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'purchase-proof', 'professional-installation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://www.statefarm.com/simple-insights/residence/water-leak-detection',
    programNotes: 'State Farm publishes guidance on whole-home leak detection with automatic shutoff but directs policyholders to their agent for policy-specific eligibility.'
  },
  {
    id: 'usaa',
    name: 'USAA',
    logo: null,
    discountProgramName: 'Connected Home / smart-home prevention',
    discountPercentage: 'Ask USAA to confirm',
    submissionEmail: null,
    submissionPortalUrl: null,
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'activation-proof', 'commissioning-evidence', 'monitoring-evidence'],
    sourceUrl: 'https://www.usaa.com/SaveMoney',
    programNotes: 'USAA states that connected-home prevention devices can lead to additional home-premium discounts; availability depends on the member and policy.'
  },
  {
    id: 'nationwide',
    name: 'Nationwide',
    logo: null,
    discountProgramName: 'Nationwide Smart Home program',
    discountPercentage: 'State and policy specific',
    submissionEmail: null,
    submissionPortalUrl: 'https://www.nationwide.com/personal/insurance/homeowners/smart-home/',
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'activation-proof', 'professional-installation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://www.nationwide.com/personal/insurance/homeowners/smart-home/',
    programNotes: 'Nationwide requires an eligible system to be installed, activated, and linked to the member account; approved-device rules apply.'
  },
  {
    id: 'travelers',
    name: 'Travelers',
    logo: null,
    discountProgramName: 'Quantum Home 2.0 protective-device discounts',
    discountPercentage: 'State and policy specific',
    submissionEmail: null,
    submissionPortalUrl: null,
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'activation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://www.travelers.com/resources/home/smart-home/how-smart-home-technology-helps-protect-your-home',
    programNotes: 'Travelers describes separate water-sensor and automatic water-shutoff protective-device categories. The agent must confirm qualification.'
  },
  {
    id: 'american-family',
    name: 'American Family Insurance',
    logo: null,
    discountProgramName: 'Safe, Secure, Smart Home discount',
    discountPercentage: 'State and policy specific',
    submissionEmail: null,
    submissionPortalUrl: null,
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'activation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://www.amfam.com/insurance/home/discounts/safe-secure-smart-home-discount',
    programNotes: 'American Family identifies connected water-leak and humidity sensors with shutoff capability as potentially qualifying smart-home devices.'
  },
  {
    id: 'chubb',
    name: 'Chubb',
    logo: null,
    discountProgramName: 'Water leak detection and automatic shutoff',
    discountPercentage: 'State and policy specific',
    submissionEmail: null,
    submissionPortalUrl: 'https://www.chubb.com/us-en/agents-brokers/resources/water-coverage.html',
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'installation-photo', 'installer-invoice', 'professional-installation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://www.chubb.com/us-en/individuals-families/resources/the-smartest-way-to-prevent-water-damage-7-tips-to-get-you-started.html',
    programNotes: 'Chubb specifically advises providing an installation certificate or a photo of the installed device with the installation invoice.'
  },
  {
    id: 'hippo',
    name: 'Hippo',
    logo: null,
    discountProgramName: 'Smart Home discount',
    discountPercentage: 'State and policy specific',
    submissionEmail: null,
    submissionPortalUrl: null,
    requiresProof: true,
    acceptedProofTypes: ['property-certificate', 'activation-proof', 'commissioning-evidence'],
    sourceUrl: 'https://faq.hippo.com/en/articles/4734343-q-what-discounts-does-hippo-offer',
    programNotes: 'Hippo describes a smart-home discount for activating eligible devices. Confirm whether third-party systems qualify before submission.'
  }
];

export default insurers;
