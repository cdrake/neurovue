import { useMemo, useState } from 'react'
import type { DesktopItem } from '../domain/desktop'
import {
  volumeFacetValue,
  volumeImageTypeLabel,
  volumeRoleLabel,
  volumeSearchText,
} from '../domain/volumeFacets'

export interface VolumeFilters {
  query: string
  selectedRoles: Set<string>
  selectedImageTypes: Set<string>
  selectedFormats: Set<string>
  selectedDtypes: Set<string>
  filteredItems: DesktopItem[]
  setQuery: (query: string) => void
  toggleRole: (value: string) => void
  toggleImageType: (value: string) => void
  toggleFormat: (value: string) => void
  toggleDtype: (value: string) => void
  /** Clear the query and all facet selections (leaves the selection). */
  clearFilters: () => void
  /** Replace the query and facet selections; an absent field matches all. */
  setFilters: (filters: VolumeFilterValues) => void
}

/** A whole filter, as an agent sets it: facet values are their labels. */
export interface VolumeFilterValues {
  query?: string
  roles?: string[]
  imageTypes?: string[]
  formats?: string[]
  dtypes?: string[]
}

function toggleValue(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

/** Owns the volume filter state (query + facet selections) and the derived
 *  filtered list. */
export function useVolumeFilters(items: DesktopItem[]): VolumeFilters {
  const [query, setQuery] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(
    () => new Set(),
  )
  const [selectedImageTypes, setSelectedImageTypes] = useState<Set<string>>(
    () => new Set(),
  )
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(
    () => new Set(),
  )
  const [selectedDtypes, setSelectedDtypes] = useState<Set<string>>(
    () => new Set(),
  )

  const filteredItems = useMemo(
    () =>
      filterVolumes(items, {
        query,
        roles: [...selectedRoles],
        imageTypes: [...selectedImageTypes],
        formats: [...selectedFormats],
        dtypes: [...selectedDtypes],
      }),
    [
      items,
      query,
      selectedDtypes,
      selectedFormats,
      selectedImageTypes,
      selectedRoles,
    ],
  )

  function clearFilters(): void {
    setQuery('')
    setSelectedRoles(new Set())
    setSelectedImageTypes(new Set())
    setSelectedFormats(new Set())
    setSelectedDtypes(new Set())
  }

  function setFilters(filters: VolumeFilterValues): void {
    setQuery(filters.query ?? '')
    setSelectedRoles(new Set(filters.roles))
    setSelectedImageTypes(new Set(filters.imageTypes))
    setSelectedFormats(new Set(filters.formats))
    setSelectedDtypes(new Set(filters.dtypes))
  }

  return {
    query,
    selectedRoles,
    selectedImageTypes,
    selectedFormats,
    selectedDtypes,
    filteredItems,
    setQuery,
    toggleRole: (value) =>
      setSelectedRoles((current) => toggleValue(current, value)),
    toggleImageType: (value) =>
      setSelectedImageTypes((current) => toggleValue(current, value)),
    toggleFormat: (value) =>
      setSelectedFormats((current) => toggleValue(current, value)),
    toggleDtype: (value) =>
      setSelectedDtypes((current) => toggleValue(current, value)),
    clearFilters,
    setFilters,
  }
}

/** The volumes a filter keeps: each facet given must match, and the query
 *  must appear in the volume's search text. */
export function filterVolumes(
  items: DesktopItem[],
  filters: VolumeFilterValues,
): DesktopItem[] {
  const normalized = (filters.query ?? '').trim().toLowerCase()
  const keeps = (values: string[] | undefined, value: string) =>
    !values?.length || values.includes(value)
  return items.filter(
    (item) =>
      keeps(filters.roles, volumeRoleLabel(item)) &&
      keeps(filters.imageTypes, volumeImageTypeLabel(item)) &&
      keeps(filters.formats, volumeFacetValue(item.format)) &&
      keeps(filters.dtypes, volumeFacetValue(item.dtype)) &&
      (!normalized || volumeSearchText(item).includes(normalized)),
  )
}
