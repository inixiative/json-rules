export const mapDayNames = (days: string[]): number[] => {
  const dayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return days.map((d) => {
    const num = dayMap[d.toLowerCase()];
    if (num === undefined) throw new Error(`Unknown day name: ${d}`);
    return num;
  });
};
