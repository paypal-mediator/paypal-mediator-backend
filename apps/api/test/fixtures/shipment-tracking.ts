// Explicit MOCK provider payload, matching the documented 17TRACK v2.4 envelope.
export function mock17Track(
  number = 'MOCKGUIDE123',
  status = 'Delivered',
  time = new Date().toISOString(),
) {
  const event = {
    time_utc: time,
    time_iso: time,
    stage: status,
    sub_status: status,
    description: `MOCK ${status} scan`,
    location: 'MOCK location',
  };
  return {
    number,
    carrier: 100003,
    tag: null,
    track_info: {
      latest_status: { status, sub_status: status },
      latest_event: event,
      milestone: [{ key_stage: status, time_utc: time, time_iso: time }],
      tracking: {
        providers: [
          {
            provider: { key: 100003, name: 'MOCK Carrier' },
            latest_sync_status: 'Success',
            latest_sync_time: time,
            events: [event],
          },
        ],
      },
    },
  };
}
export function mock17Envelope(item: Record<string, unknown>) {
  return { code: 0, data: { accepted: [item], rejected: [] } };
}
export function mock17Rejected(number: string, code: number) {
  return {
    code: 0,
    data: {
      accepted: [],
      rejected: [
        {
          number,
          error: { code, message: 'MOCK provider error with private details' },
        },
      ],
    },
  };
}
