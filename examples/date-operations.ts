import { check, DateOperator } from '../index';

// Example 1: Date comparisons
const expiryRule = {
  field: 'expiryDate',
  dateOperator: DateOperator.after,
  value: new Date().toISOString(), // Must be after today
  error: 'Product has expired'
};

const validProduct = {
  expiryDate: '2025-12-31'
};

const expiredProduct = {
  expiryDate: '2023-01-01'
};

console.log(check(expiryRule, validProduct)); // true
console.log(check(expiryRule, expiredProduct)); // "Product has expired"

// Example 2: Date range validation
const eventDateRule = {
  field: 'eventDate',
  dateOperator: DateOperator.between,
  value: ['2024-01-01', '2024-12-31'],
  error: 'Event must be scheduled in 2024'
};

const validEvent = { eventDate: '2024-06-15' };
const invalidEvent = { eventDate: '2025-01-15' };

console.log(check(eventDateRule, validEvent)); // true
console.log(check(eventDateRule, invalidEvent)); // "Event must be scheduled in 2024"

// Example 3: Day of week validation
const weekdayOnlyRule = {
  field: 'appointmentDate',
  dateOperator: DateOperator.dayIn,
  value: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  error: 'Appointments are only available on weekdays'
};

const weekdayAppointment = { appointmentDate: '2024-01-15' }; // Monday
const weekendAppointment = { appointmentDate: '2024-01-13' }; // Saturday

console.log(check(weekdayOnlyRule, weekdayAppointment)); // true
console.log(check(weekdayOnlyRule, weekendAppointment)); // "Appointments are only available on weekdays"

// Example 4: Comparing dates between fields
const endAfterStartRule = {
  field: 'endDate',
  dateOperator: DateOperator.after,
  path: 'startDate', // Compare against another field
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

console.log(check(endAfterStartRule, validRange)); // true
console.log(check(endAfterStartRule, invalidRange)); // "End date must be after start date"

// Example 5: Complex date validation with logical operators
const bookingRule = {
  all: [
    // Must be in the future
    {
      field: 'bookingDate',
      dateOperator: DateOperator.after,
      value: new Date().toISOString()
    },
    // Must be within next 90 days
    {
      field: 'bookingDate',
      dateOperator: DateOperator.before,
      value: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    },
    // Not on weekends
    {
      field: 'bookingDate',
      dateOperator: DateOperator.dayNotIn,
      value: ['saturday', 'sunday']
    }
  ]
};

// Example 6: Date validation in arrays
const upcomingEventsRule = {
  field: 'events',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'date',
    dateOperator: DateOperator.onOrAfter,
    value: new Date().toISOString()
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

console.log(check(upcomingEventsRule, events)); // true