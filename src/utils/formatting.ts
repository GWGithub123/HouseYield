// Format currency values based on magnitude
export const formatCurrency = (value: number): string => {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(absValue >= 10_000_000 ? 0 : 2)}M`;
  } else if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(absValue >= 10_000 ? 0 : 2)}k`;
  } else {
    return `${sign}$${absValue.toFixed(2)}`;
  }
};

// Format percentage values
export const formatPercentage = (value: number): string => {
  return `${value.toFixed(1)}%`;
};
