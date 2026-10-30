export interface AvailabilityCheckRequest {
  hotelId: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  rooms: { roomTypeId: string; guests: number }[];
}

export interface AvailabilityCheckResponse {
  status: 'available' | 'unavailable' | 'on_request';
  checkedAt: Date;
  note?: string;
}

export interface AvailabilityProvider {
  checkAvailability(req: AvailabilityCheckRequest): Promise<AvailabilityCheckResponse>;
}

export class ManualAvailabilityProvider implements AvailabilityProvider {
  async checkAvailability(_req: AvailabilityCheckRequest): Promise<AvailabilityCheckResponse> {
    return {
      status: 'on_request',
      checkedAt: new Date(),
      note: 'Manual availability confirmation required with hotel',
    };
  }
}

export const defaultAvailabilityProvider: AvailabilityProvider = new ManualAvailabilityProvider();
