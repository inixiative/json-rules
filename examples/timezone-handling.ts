import { check, DateOperator } from '../index';

// Example 1: Date-only comparisons with timezone-aware data
console.log('=== Date-only comparisons ===');

// When condition value has no timezone, it's interpreted in the field's timezone
const dateOnlyRule = {
  field: 'eventDate',
  dateOperator: DateOperator.onOrAfter,
  value: '2025-01-20' // No timezone - will use field's timezone
};

// Sydney time: Jan 20 10:00 AM (UTC+11)
const sydneyEvent = { eventDate: '2025-01-20T10:00:00+11:00' };
console.log('Sydney event (Jan 20 10am local):', check(dateOnlyRule, sydneyEvent)); // true

// LA time: Jan 19 11:00 PM (UTC-8) - same moment as Sydney example
const laEvent = { eventDate: '2025-01-20T07:00:00-08:00' };
console.log('LA event (Jan 20 7am local):', check(dateOnlyRule, laEvent)); // true

// UTC time: Jan 19 11:00 PM - before Jan 20 in UTC
const utcEvent = { eventDate: '2025-01-19T23:00:00Z' };
console.log('UTC event (Jan 19 11pm):', check(dateOnlyRule, utcEvent)); // false

// Example 2: Explicit timezone in condition
console.log('\n=== Explicit timezone in condition ===');

const utcMidnightRule = {
  field: 'eventDate',
  dateOperator: DateOperator.after,
  value: '2025-01-20T00:00:00Z' // Explicit UTC midnight
};

console.log('Before UTC midnight:', check(utcMidnightRule, { eventDate: '2025-01-19T23:59:59Z' })); // false
console.log('After UTC midnight:', check(utcMidnightRule, { eventDate: '2025-01-20T00:00:01Z' })); // true

// Example 3: Business hours validation across timezones
console.log('\n=== Business hours validation ===');

const businessHoursRule = {
  field: 'submittedAt',
  dateOperator: DateOperator.between,
  value: ['2025-01-20T09:00:00', '2025-01-20T17:00:00'] // 9 AM to 5 PM in submission timezone
};

// Submission from Sydney at 10 AM local time
const sydneySubmission = { submittedAt: '2025-01-20T10:00:00+11:00' };
console.log('Sydney 10 AM submission:', check(businessHoursRule, sydneySubmission)); // true

// Submission from Sydney at 8 AM local time
const earlySydneySubmission = { submittedAt: '2025-01-20T08:00:00+11:00' };
console.log('Sydney 8 AM submission:', check(businessHoursRule, earlySydneySubmission)); // false

// Example 4: Deadline enforcement
console.log('\n=== Deadline enforcement ===');

const deadlineRule = {
  field: 'submittedAt',
  dateOperator: DateOperator.before,
  value: '2025-01-20T23:59:59',
  error: 'Submission deadline has passed'
};

// Someone in Tokyo submits on Jan 20 at 11:30 PM their time
const tokyoSubmission = { submittedAt: '2025-01-20T23:30:00+09:00' };
console.log('Tokyo late submission:', check(deadlineRule, tokyoSubmission)); // true (still before deadline in their timezone)

// Someone in New York submits on Jan 21 at 12:30 AM their time
const nyLateSubmission = { submittedAt: '2025-01-21T00:30:00-05:00' };
console.log('NY late submission:', check(deadlineRule, nyLateSubmission)); // "Submission deadline has passed"

// Example 5: Day of week with timezones
console.log('\n=== Day of week validation ===');

const weekdayOnlyRule = {
  field: 'appointmentDate',
  dateOperator: DateOperator.dayIn,
  value: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  error: 'Appointments must be on weekdays'
};

// Friday 11 PM in Hawaii could be Saturday in Sydney
const hawaiiFriday = { appointmentDate: '2025-01-17T23:00:00-10:00' }; // Friday in Hawaii
console.log('Hawaii Friday night:', check(weekdayOnlyRule, hawaiiFriday)); // true (still Friday locally)

// Example 6: Comparing dates without timezone info
console.log('\n=== No timezone handling ===');

const noTimezoneRule = {
  field: 'date',
  dateOperator: DateOperator.after,
  value: '2025-01-20'
};

// When field has no timezone, both are treated as local time
const localDate = { date: '2025-01-21T10:00:00' }; // No timezone = local
console.log('Local date comparison:', check(noTimezoneRule, localDate)); // true