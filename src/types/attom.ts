/**
 * TypeScript interfaces for ATTOM Property Data
 * Matches the structure returned by server/attom.js fetchPropertyDashboard()
 */

export interface PropertySummary {
  address?: string;
  year_built?: number;
  property_type?: string;
  lot_acres?: number;
  attom_id?: string;
  latitude?: number;
  longitude?: number;
  beds?: number;
  baths?: number;
  living_sqft?: number;
  avm_value?: number;
  avm_low?: number;
  avm_high?: number;
  rental_avm?: number;
  rental_avm_low?: number;
  rental_avm_high?: number;
  assessed_value?: number;
  last_sale_date?: string;
  last_sale_price?: number;
  price_per_sqft?: number;
  age?: number;
  area_context?: {
    county?: string;
    municipality?: string;
    municipality_code?: string;
    census_tract?: string;
    census_block_group?: string;
    tax_code_area?: string;
    zoning?: string;
    fips?: string;
    state_code?: string;
  };
  mortgage?: {
    lender_name?: string;
    lender_code?: string;
    amount?: number;
    date?: string;
    loan_type?: string;
    deed_type?: string;
    term_months?: number;
    due_date?: string;
    title_company?: string;
    estimated_interest_rate?: number;
    estimated_monthly_payment_pi?: number;
    estimated_total_interest?: number;
    estimated_total_paid?: number;
    assumability?: {
      assumable: string;
      confidence: string;
      reason: string;
      loanType?: string;
      loanDate?: string;
      estimatedRate?: number;
      attractiveness?: string;
      nextSteps?: string[];
      disclaimer?: string;
    };
    payment_breakdown?: {
      principal_and_interest: number;
      property_tax: number;
      total_pi_plus_tax: number;
    };
  };
  owner?: {
    is_corporate?: boolean;
    owner1_name?: string;
    owner2_name?: string;
    owner3_name?: string;
    owner4_name?: string;
    relationship_type?: string;
    absentee_status?: string;
    mailing_address?: string;
  };
}

export interface TaxHistory {
  year: number;
  tax_amount?: number;
  assessed_total?: number;
  land_value?: number;
  improvement_value?: number;
  tax_amount_yoy_pct?: number;
}

export interface TaxMeta {
  count: number;
  cagr_full?: number | null;
  cagr_5yr?: number | null;
}

export interface AVMHistory {
  date: string;
  value?: number;
  low?: number;
  high?: number;
}

export interface AVMComparableContext {
  comparableCount?: number;
  comparableAddresses?: string[];
  currentMeanAvm?: number | null;
  generatedAt?: string;
  maxResults?: number;
  radiusMiles?: number;
  source?: string;
}

export interface EnvironmentalRisk {
  flood?: any;
  earthquake?: any;
  fire?: any;
  wind?: any;
  hail?: any;
  tornado?: any;
  hurricane?: any;
  airQuality?: any;
}

export interface BuildingPermit {
  source: string;
  permit_number?: string;
  permit_type?: string;
  permit_type_description?: string;
  issue_date?: string;
  work_description?: string;
  contractor_name?: string;
  contractor_company?: string;
  estimated_cost?: number;
  status?: string;
  square_feet?: number;
  address?: string;
}

export interface School {
  name?: string;
  district?: string;
  level?: string;
  grades?: string;
  rating?: number;
  distance?: number;
  type?: string;
  latitude?: number;
  longitude?: number;
  geoId?: string;
}

export interface SchoolDistrict {
  name?: string;
  code?: string;
  nces_id?: string;
  type?: string;
  total_schools?: number;
  enrollment?: number;
  pupil_teacher_ratio?: number;
  spending_per_student?: number;
  graduation_rate?: number;
  rating?: number;
}

export interface ParcelGeometry {
  type: string;
  coordinates: number[][][];
  centroid?: {
    lat: number;
    lng: number;
  };
}

export interface TransportationNoise {
  airport?: any;
  highway?: any;
  railway?: any;
  overall_score?: number;
  description?: string;
}

export interface CommunityData {
  crime?: {
    crime_index?: number;
    violent_crime?: number;
    property_crime?: number;
    murder?: number;
    robbery?: number;
    assault?: number;
    burglary?: number;
    larceny?: number;
    vehicle_theft?: number;
    arson?: number;
  };
  walk_score?: number;
  transit_score?: number;
  bike_score?: number;
  demographics?: {
    population?: number;
    median_income?: number;
    median_age?: number;
    college_educated_pct?: number;
    owner_occupied_pct?: number;
  };
}

export interface PropertyDashboard {
  summary: PropertySummary;
  tax_history: TaxHistory[];
  tax_meta: TaxMeta;
  avm_history?: AVMHistory[];
  avm_comparable_history?: AVMHistory[];
  avm_comparable_context?: AVMComparableContext;
  environmental?: EnvironmentalRisk;
  building_permits?: BuildingPermit[];
  schools?: School[];
  school_district?: SchoolDistrict;
  community?: CommunityData;
  parcel_geometry?: ParcelGeometry;
  transportation_noise?: TransportationNoise;
  location?: {
    latitude: number;
    longitude: number;
  };
  components?: any;
  raw?: any;
}
