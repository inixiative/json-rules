import { describe, expect, test } from 'bun:test';
import { check, DateOperator, ArrayOperator } from '../index';

describe('Date Operations Examples', () => {
  test('date comparisons', () => {
    const expiryRule = {
      field: 'expiryDate',
      dateOperator: DateOperator.after,
      value: '2024-01-01',
      error: 'Product has expired'
    };

    const validProduct = {
      expiryDate: '2025-12-31'
    };

    const expiredProduct = {
      expiryDate: '2023-01-01'
    };

    expect(check(expiryRule, validProduct)).toBe(true);
    expect(check(expiryRule, expiredProduct)).toBe('Product has expired');
  });

  test('date range validation', () => {
    const eventDateRule = {
      field: 'eventDate',
      dateOperator: DateOperator.between,
      value: ['2024-01-01', '2024-12-31'],
      error: 'Event must be scheduled in 2024'
    };

    const validEvent = { eventDate: '2024-06-15' };
    const invalidEvent = { eventDate: '2025-01-15' };

    expect(check(eventDateRule, validEvent)).toBe(true);
    expect(check(eventDateRule, invalidEvent)).toBe('Event must be scheduled in 2024');
  });

  test('day of week validation', () => {
    const weekdayOnlyRule = {
      field: 'appointmentDate',
      dateOperator: DateOperator.dayIn,
      value: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      error: 'Appointments are only available on weekdays'
    };

    const weekdayAppointment = { appointmentDate: '2024-01-15' }; // Monday
    const weekendAppointment = { appointmentDate: '2024-01-13' }; // Saturday

    expect(check(weekdayOnlyRule, weekdayAppointment)).toBe(true);
    expect(check(weekdayOnlyRule, weekendAppointment)).toBe('Appointments are only available on weekdays');
  });

  test('comparing dates between fields', () => {
    const endAfterStartRule = {
      field: 'endDate',
      dateOperator: DateOperator.after,
      path: 'startDate',
      error: 'End date must be after start date'
    };

    const validRange = {
      startDate: '2024-01-01',
      endDate: '2024-01-31'
    };

    const invalidRange = {
      startDate: '2024-01-31',
      endDate: '2024-01-01'
    };

    expect(check(endAfterStartRule, validRange)).toBe(true);
    expect(check(endAfterStartRule, invalidRange)).toBe('End date must be after start date');
  });

  test('complex date validation with logical operators', () => {
    const bookingRule = {
      all: [
        {
          field: 'bookingDate',
          dateOperator: DateOperator.after,
          value: new Date().toISOString()
        },
        {
          field: 'bookingDate',
          dateOperator: DateOperator.before,
          value: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
          field: 'bookingDate',
          dateOperator: DateOperator.dayNotIn,
          value: ['saturday', 'sunday']
        }
      ]
    };

    // Test with a valid weekday in the near future
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    // If tomorrow is weekend, skip to Monday
    if (tomorrow.getDay() === 0) tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getDay() === 6) tomorrow.setDate(tomorrow.getDate() + 2);

    const validBooking = { bookingDate: tomorrow.toISOString() };
    expect(check(bookingRule, validBooking)).toBe(true);
  });

  test('date validation in arrays', () => {
    const upcomingEventsRule = {
      field: 'events',
      arrayOperator: ArrayOperator.all,
      condition: {
        field: 'date',
        dateOperator: DateOperator.onOrAfter,
        value: '2024-01-01'
      },
      error: 'All events must be in the future'
    };

    const events = {
      events: [
        { name: 'Conference', date: '2025-03-15' },
        { name: 'Workshop', date: '2025-04-20' },
        { name: 'Seminar', date: '2025-05-10' }
      ]
    };

    expect(check(upcomingEventsRule, events)).toBe(true);
  });
});