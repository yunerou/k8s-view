/** `eu-west-1`, `ap-southeast-2`, `us-gov-west-1`… */
export function isRegionCode(value: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(value);
}
