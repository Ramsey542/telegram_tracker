export function solanaSwapProvider(address: string): 'pump' | 'jupiter' {
  return address.endsWith('pump') ? 'pump' : 'jupiter';
}
