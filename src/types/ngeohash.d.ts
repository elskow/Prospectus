declare module "ngeohash" {
  export function encode(lat: number, lng: number, precision: number): string;
  export function decode(hash: string): { latitude: number; longitude: number; error?: { latitude: number; longitude: number } };
  export function decode_bbox(hash: string): [south: number, west: number, north: number, east: number];
  export function neighbors(hash: string): {
    north: string;
    south: string;
    east: string;
    west: string;
    northeast: string;
    northwest: string;
    southeast: string;
    southwest: string;
  };
  export function bboxes(minLat: number, minLon: number, maxLat: number, maxLon: number, numberOfChars: number): string[];
  export function bounds(hash: string): { south: number; west: number; north: number; east: number };
}
