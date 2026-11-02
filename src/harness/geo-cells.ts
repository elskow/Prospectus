import geohash from "ngeohash";

export type GeoCell = { hash: string; lat: number; lng: number };

export function companyGeoCell(lat: number | null, lng: number | null, precision = 5): string | null {
  if (lat === null || lng === null) return null;

  return geohash.encode(lat, lng, precision);
}

export function cellCenter(hash: string): { lat: number; lng: number } {
  const { latitude, longitude } = geohash.decode(hash);

  return { lat: latitude, lng: longitude };
}

export function cellNeighbors(hash: string): string[] {
  return Object.values(geohash.neighbors(hash));
}

export function cellsForRegion(region: { south: number; west: number; north: number; east: number }, precision = 5): string[] {
  return geohash.bboxes(region.south, region.west, region.north, region.east, precision);
}

export function isInsideCell(hash: string, lat: number, lng: number): boolean {
  const [south, west, north, east] = geohash.decode_bbox(hash);

  return lat >= south && lat <= north && lng >= west && lng <= east;
}

export function belongsToCell(cellHash: string, lat: number, lng: number): boolean {
  const point = geohash.encode(lat, lng, cellHash.length);
  if (point === cellHash) return true;
  return Object.values(geohash.neighbors(cellHash)).includes(point);
}

export function cellSpanKm(hash: string): { height: number; width: number } {
  const [south, west, north, east] = geohash.decode_bbox(hash);

  const heightKm = Math.abs(north - south) * 111.32;
  const midLat = (north + south) / 2;
  const widthKm = Math.abs(east - west) * 111.32 * Math.cos((midLat * Math.PI) / 180);

  return { height: heightKm, width: widthKm };
}
