import { describe, expect, it } from 'vitest'
import {
  isoWeekKey,
  isoWeekRange,
  localDayKey,
  monthKey,
  monthWeekKeys,
  parentPeriod,
  parseIsoWeekKey,
  parseMonthKey,
  periodId,
  periodRange,
  rollupPeriodOf,
  startOfNextLocalDay,
  weekMonthKey,
} from '../../src/summarize/jobs/index.ts'
import { at } from './helpers.ts'

describe('period keys', () => {
  it('formats ISO weeks in local time, including year boundaries', () => {
    expect(isoWeekKey(at(2026, 11, 22, 23, 59))).toBe('2026-W47')
    expect(isoWeekKey(at(2026, 11, 23, 0, 0))).toBe('2026-W48')
    expect(isoWeekKey(at(2026, 1, 1))).toBe('2026-W01')
    expect(isoWeekKey(at(2027, 1, 1))).toBe('2026-W53')
    expect(isoWeekKey(at(2027, 1, 4))).toBe('2027-W01')
    expect(isoWeekKey(at(2024, 12, 30))).toBe('2025-W01')
  })

  it('formats calendar months and local days', () => {
    expect(monthKey(at(2026, 11, 1, 0, 0))).toBe('2026-11')
    expect(monthKey(at(2026, 1, 31, 23, 59))).toBe('2026-01')
    expect(localDayKey(at(2026, 3, 9, 23, 59))).toBe('2026-03-09')
    expect(startOfNextLocalDay(at(2026, 12, 31, 18))).toBe(at(2027, 1, 1, 0))
  })

  it('parses and validates keys', () => {
    expect(parseIsoWeekKey('2026-W53')).toEqual({ year: 2026, week: 53 })
    expect(parseIsoWeekKey('2025-W53')).toBeUndefined()
    expect(parseIsoWeekKey('2026-W00')).toBeUndefined()
    expect(parseIsoWeekKey('2026-47')).toBeUndefined()
    expect(parseMonthKey('2026-11')).toEqual({ year: 2026, month: 11 })
    expect(parseMonthKey('2026-13')).toBeUndefined()
  })

  it('gives week ranges as local Monday-to-Monday spans', () => {
    expect(isoWeekRange('2026-W48')).toEqual({ from: at(2026, 11, 23, 0), to: at(2026, 11, 30, 0) })
    expect(isoWeekRange('2026-W01')).toEqual({ from: at(2025, 12, 29, 0), to: at(2026, 1, 5, 0) })
    expect(isoWeekRange('nope')).toBeUndefined()
  })

  it('assigns each ISO week to the month of its Thursday so periods nest', () => {
    expect(weekMonthKey('2026-W44')).toBe('2026-10')
    expect(weekMonthKey('2026-W45')).toBe('2026-11')
    expect(rollupPeriodOf('month', at(2026, 11, 1))).toEqual({ kind: 'month', key: '2026-10' })
    expect(rollupPeriodOf('week', at(2026, 11, 1))).toEqual({ kind: 'week', key: '2026-W44' })
    expect(rollupPeriodOf('year', at(2027, 1, 1))).toEqual({ kind: 'year', key: '2026' })
    expect(monthWeekKeys('2026-11')).toEqual(['2026-W45', '2026-W46', '2026-W47', '2026-W48'])
    expect(periodRange({ kind: 'month', key: '2026-11' })).toEqual({ from: at(2026, 11, 2, 0), to: at(2026, 11, 30, 0) })
    expect(periodRange({ kind: 'year', key: '2026' })).toEqual({ from: at(2025, 12, 29, 0), to: at(2027, 1, 4, 0) })
  })

  it('links periods to their parents', () => {
    expect(parentPeriod({ kind: 'week', key: '2026-W44' })).toEqual({ kind: 'month', key: '2026-10' })
    expect(parentPeriod({ kind: 'month', key: '2026-10' })).toEqual({ kind: 'year', key: '2026' })
    expect(parentPeriod({ kind: 'year', key: '2026' })).toBeUndefined()
    expect(periodId({ kind: 'week', key: '2026-W44' })).toBe('week:2026-W44')
  })
})
