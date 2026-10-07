import { check, DateOperator } from '../index';

// One evaluation reads dates in one zone: `timeZone` in the options, UTC by default (never the
// host's). A value with an explicit zone (`Z` or `±HH:MM`) is an exact instant; a zoneless
// string is anchored in the evaluation's zone. See docs/TIMEZONE.md.

// Example 1: Date-only comparisons
console.log('=== Date-only comparisons ===');

const dateOnlyRule = {
  field: 'eventDate',
  dateOperator: DateOperator.onOrAfter,
  value: '2025-01-20', // zoneless: midnight in the evaluation's zone
};

// Jan 20 10:00 AM in Sydney (UTC+11) is Jan 19 23:00 UTC
const sydneyEvent = { eventDate: '2025-01-20T10:00:00+11:00' };
console.log('Sydney event, UTC:', check(dateOnlyRule, sydneyEvent)); // "eventDate must be on or after …"
console.log(
  'Sydney event, Sydney:',
  check(dateOnlyRule, sydneyEvent, { timeZone: 'Australia/Sydney' }),
); // true

// Jan 20 7:00 AM in LA (UTC-8) is Jan 20 15:00 UTC
const laEvent = { eventDate: '2025-01-20T07:00:00-08:00' };
console.log('LA event, UTC:', check(dateOnlyRule, laEvent)); // true

const utcEvent = { eventDate: '2025-01-19T23:00:00Z' };
console.log('UTC event (Jan 19 11pm):', check(dateOnlyRule, utcEvent)); // "eventDate must be on or after …"

// Example 2: Explicit zone in the rule
console.log('\n=== Explicit zone in the rule ===');

const utcMidnightRule = {
  field: 'eventDate',
  dateOperator: DateOperator.after,
  value: '2025-01-20T00:00:00Z', // an exact instant, whatever the evaluation's zone
};

console.log('Before UTC midnight:', check(utcMidnightRule, { eventDate: '2025-01-19T23:59:59Z' })); // "eventDate must be after …"
console.log('After UTC midnight:', check(utcMidnightRule, { eventDate: '2025-01-20T00:00:01Z' })); // true

// Example 3: Business hours in one zone
console.log('\n=== Business hours validation ===');

const businessHoursRule = {
  field: 'submittedAt',
  dateOperator: DateOperator.between,
  value: ['2025-01-20T09:00:00', '2025-01-20T17:00:00'], // 9 AM to 5 PM in the evaluation's zone
};

const sydney = { timeZone: 'Australia/Sydney' };

const sydneySubmission = { submittedAt: '2025-01-20T10:00:00+11:00' };
console.log('Sydney 10 AM submission:', check(businessHoursRule, sydneySubmission, sydney)); // true

const earlySydneySubmission = { submittedAt: '2025-01-20T08:00:00+11:00' };
console.log('Sydney 8 AM submission:', check(businessHoursRule, earlySydneySubmission, sydney)); // "submittedAt must be between …"

// Example 4: Deadline enforcement (UTC)
console.log('\n=== Deadline enforcement ===');

const deadlineRule = {
  field: 'submittedAt',
  dateOperator: DateOperator.before,
  value: '2025-01-20T23:59:59', // 23:59:59 UTC
  error: 'Submission deadline has passed',
};

// Jan 20 11:30 PM in Tokyo is Jan 20 14:30 UTC
const tokyoSubmission = { submittedAt: '2025-01-20T23:30:00+09:00' };
console.log('Tokyo late submission:', check(deadlineRule, tokyoSubmission)); // true

// Jan 21 12:30 AM in New York is Jan 21 05:30 UTC
const nyLateSubmission = { submittedAt: '2025-01-21T00:30:00-05:00' };
console.log('NY late submission:', check(deadlineRule, nyLateSubmission)); // "Submission deadline has passed"

// Example 5: Weekdays are read in the evaluation's zone
console.log('\n=== Day of week validation ===');

const weekdayOnlyRule = {
  field: 'appointmentDate',
  dateOperator: DateOperator.dayIn,
  value: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  error: 'Appointments must be on weekdays',
};

// Friday 11 PM in Hawaii is Saturday 9 AM UTC
const hawaiiFriday = { appointmentDate: '2025-01-17T23:00:00-10:00' };
console.log('Hawaii Friday night, UTC:', check(weekdayOnlyRule, hawaiiFriday)); // "Appointments must be on weekdays"
console.log(
  'Hawaii Friday night, Honolulu:',
  check(weekdayOnlyRule, hawaiiFriday, { timeZone: 'Pacific/Honolulu' }),
); // true

// Example 6: Both sides zoneless
console.log('\n=== No zone on either side ===');

const noTimezoneRule = {
  field: 'date',
  dateOperator: DateOperator.after,
  value: '2025-01-20',
};

// Both strings are anchored in the same zone, so the result never depends on it
const localDate = { date: '2025-01-21T10:00:00' };
console.log('Zoneless comparison:', check(noTimezoneRule, localDate)); // true
