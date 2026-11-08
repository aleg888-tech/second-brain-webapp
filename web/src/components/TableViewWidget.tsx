import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  CircleDot,
  Clock,
  Code,
  ExternalLink,
  EyeOff,
  FileText,
  Filter,
  FolderOpen,
  Hash,
  Link as LinkIcon,
  List,
  ListFilter,
  Mail,
  Phone,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type {
  EffectiveColumnMeta,
  FilterOperator,
  PropertyColor,
  PropertyDefinition,
  PropertyOption,
  PropertyType,
  StatusGroup,
  TableQueryResponse,
  TableRowItem,
  VistaBlockConfig,
  VistaFilter,
  VistaSort,
} from '@brain/shared';
import { api } from '../api/client';
import {
  addPropertyToSchema,
  changePropertyTypeInSchema,
  COLOR_PALETTE_META,
  createDefaultOptionsForType,
  deletePropertyFromSchema,
  FILTER_OPERATOR_META,
  filterTableRows,
  formatItalianDate,
  formatNumberWithDecimals,
  getPropertyTypeLabel,
  getRowCellValue,
  PRIMARY_PROPERTY_TYPE_META,
  PROPERTY_COLORS,
  renamePropertyInSchema,
  reorderPropertiesInSchema,
  restoreUndefinedPropertyToSchema,
  setPropertyDecimalsInSchema,
  setPropertyDefaultInSchema,
  sortTableRows,
  STATUS_GROUP_LABELS,
  STATUS_GROUPS,
  updatePropertyOptionsInSchema,
  type ParseVistaResult,
} from '../core/table-ui';

export interface TableViewWidgetProps {
  /** Percorso della pagina ospite in cui si trova il blocco (o del database aperto a pagina intera). */
  hostPath: string;
  /** Risultato del parsing del blocco vista (o sintetico per database a pagina intera / legacy embed). */
  parsedBlock: ParseVistaResult;
  /** Indica se il blocco proviene dalla sintassi legacy ![[page:p_...]]. */
  isLegacyEmbed?: boolean;
  /** Testo grezzo originale del blocco nel Markdown. */
  rawBlock?: string;
  /** Se true, il componente è mostrato come pagina database intera anziché dentro un blocco dell'editor. */
  fullPageDatabase?: boolean;
  /** Apre una pagina nell'editor principale. */
  onOpenPage: (path: string) => void;
  /** Salva il nuovo blocco ```vista ... ``` nel Markdown della pagina ospite. */
  onSaveVistaBlock?: (nextConfig: VistaBlockConfig, isLegacyConversion: boolean) => Promise<void>;
  /** Sposta il cursore dentro il blocco YAML nell'editor per modificarlo come testo. */
  onEditRawYaml?: () => void;
  /** Notifica l'app principale quando l'albero delle pagine cambia (nuova riga, archiviazione, conversione). */
  onTreeMutated?: (convertedHost?: { from: string; to: string }) => Promise<void> | void;
}

export function renderPropertyTypeIcon(tipo: PropertyType, size = 14): React.ReactNode {
  switch (tipo) {
    case 'testo':
      return <Type size={size} />;
    case 'numero':
      return <Hash size={size} />;
    case 'seleziona':
      return <ChevronDown size={size} />;
    case 'selezione-multipla':
      return <List size={size} />;
    case 'stato':
      return <CircleDot size={size} />;
    case 'data':
      return <Calendar size={size} />;
    case 'casella':
      return <CheckSquare size={size} />;
    case 'url':
      return <LinkIcon size={size} />;
    case 'email':
      return <Mail size={size} />;
    case 'telefono':
      return <Phone size={size} />;
    case 'creato':
    case 'modificato':
      return <Clock size={size} />;
    default:
      return <Type size={size} />;
  }
}

export function renderOptionPill(
  valore: string,
  opt?: PropertyOption,
  isStatus = false,
): React.ReactNode {
  const color: PropertyColor = opt?.colore ?? 'grigio';
  const palette = COLOR_PALETTE_META[color] ?? COLOR_PALETTE_META.grigio;
  return (
    <span
      className="notion-prop-pill"
      style={{
        backgroundColor: palette.bg,
        color: palette.text,
        borderColor: palette.border,
      }}
    >
      {isStatus && (
        <span
          className="notion-prop-pill-dot"
          style={{ backgroundColor: palette.dot }}
        />
      )}
      <span>{valore}</span>
    </span>
  );
}

function formatRawValueFallback(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.map((v) => String(v)).join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export const TableViewWidget: React.FC<TableViewWidgetProps> = ({
  hostPath,
  parsedBlock,
  isLegacyEmbed = false,
  rawBlock = '',
  fullPageDatabase = false,
  onOpenPage,
  onSaveVistaBlock,
  onEditRawYaml,
  onTreeMutated,
}) => {
  const [queryData, setQueryData] = useState<TableQueryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const blockConfig = parsedBlock.ok ? parsedBlock.config : undefined;

  // Stato temporaneo della vista (ordinamento, filtri, colonne visibili, larghezze, schema locale vista)
  const initialConfig: VistaBlockConfig = useMemo(
    () =>
      blockConfig ?? {
        fonte: 'sottopagine',
      },
    [blockConfig],
  );

  const [localFilters, setLocalFilters] = useState<VistaFilter[]>(initialConfig.filtri ?? []);
  const [localSorts, setLocalSorts] = useState<VistaSort[]>(initialConfig.ordina ?? []);
  const [localColumns, setLocalColumns] = useState<string[] | undefined>(
    initialConfig.colonne?.map((c) => (typeof c === 'string' ? c : c.chiave)),
  );
  const [localWidths, setLocalWidths] = useState<Record<string, number>>(
    initialConfig.larghezze ?? {},
  );
  const [localVistaProps, setLocalVistaProps] = useState<PropertyDefinition[] | undefined>(
    initialConfig.proprieta,
  );
  const [vistaDirty, setVistaDirty] = useState(false);
  const [showLegacyConvertConfirm, setShowLegacyConvertConfirm] = useState(false);

  // Pannelli temporanei barra strumenti
  const [showFilterBar, setShowFilterBar] = useState<boolean>(
    Boolean(initialConfig.filtri && initialConfig.filtri.length > 0),
  );
  const [showSortBar, setShowSortBar] = useState<boolean>(
    Boolean(initialConfig.ordina && initialConfig.ordina.length > 0),
  );
  const [showColumnsPopover, setShowColumnsPopover] = useState(false);

  // Popover "+" Nuova colonna
  const [showAddPropPopover, setShowAddPropPopover] = useState(false);
  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('testo');
  const [newPropOptions, setNewPropOptions] = useState<PropertyOption[]>([]);
  const [newOptDraft, setNewOptDraft] = useState('');

  // Menu singola colonna
  const [activeColMenuKey, setActiveColMenuKey] = useState<string | null>(null);
  const [colMenuTab, setColMenuTab] = useState<
    'main' | 'rename' | 'type' | 'options' | 'default' | 'decimals' | 'delete-confirm' | 'rename-opt-confirm' | 'generate-opts-confirm'
  >('main');
  const [colRenameInput, setColRenameInput] = useState('');
  const [colDefaultInput, setColDefaultInput] = useState('');
  const [colDecimalsInput, setColDecimalsInput] = useState<string>('');
  const [newOptionValueInput, setNewOptionValueInput] = useState('');
  const [newOptionGroupInput, setNewOptionGroupInput] = useState<StatusGroup>('da-fare');

  // Conferme esplicite con anteprima (rinomina opzione, elimina proprietà, genera opzioni da valori)
  const [pendingDeleteInfo, setPendingDeleteInfo] = useState<{
    chiave: string;
    nome: string;
    affectedCount: number;
  } | null>(null);
  const [pendingOptionRename, setPendingOptionRename] = useState<{
    chiave: string;
    oldValue: string;
    newValue: string;
    affectedCount: number;
    affectedPaths: string[];
  } | null>(null);
  const [pendingGenerateOptions, setPendingGenerateOptions] = useState<{
    chiave: string;
    targetTipo: 'seleziona' | 'selezione-multipla' | 'stato';
    generatedOptions: PropertyOption[];
  } | null>(null);

  // Editor cella attiva
  const [editingCell, setEditingCell] = useState<{
    rowPath: string;
    colKey: string;
  } | null>(null);
  const [cellDraftText, setCellDraftText] = useState<string>('');
  const [cellOptionSearch, setCellOptionSearch] = useState<string>('');
  const [dateStartDraft, setDateStartDraft] = useState<string>('');
  const [dateTimeDraft, setDateTimeDraft] = useState<string>('');
  const [dateHasEndDraft, setDateHasEndDraft] = useState<boolean>(false);
  const [dateEndDraft, setDateEndDraft] = useState<string>('');

  // Rinomina titolo riga inline
  const [editingTitleRowPath, setEditingTitleRowPath] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string>('');
  const focusRowPathRef = useRef<string | null>(null);

  // Conferma archiviazione riga
  const [confirmArchiveRow, setConfirmArchiveRow] = useState<TableRowItem | null>(null);

  // Notifica ultima modifica a una pagina riga con pulsante Annulla
  const [lastModifiedToast, setLastModifiedToast] = useState<{
    path: string;
    historyId: string | null;
    summary: string;
  } | null>(null);

  // Paginazione (fino a 500 righe per blocco, con "Mostra altre")
  const [visibleLimit, setVisibleLimit] = useState<number>(100);

  // Sincronizza con cambiamenti esterni del blocco vista
  useEffect(() => {
    if (blockConfig) {
      setLocalFilters(blockConfig.filtri ?? []);
      setLocalSorts(blockConfig.ordina ?? []);
      setLocalColumns(
        blockConfig.colonne?.map((c) => (typeof c === 'string' ? c : c.chiave)),
      );
      setLocalWidths(blockConfig.larghezze ?? {});
      setLocalVistaProps(blockConfig.proprieta);
      setVistaDirty(false);
    }
  }, [blockConfig]);

  const effectiveVistaForQuery = useMemo<VistaBlockConfig>(() => {
    return {
      fonte: initialConfig.fonte,
      ...(localColumns ? { colonne: localColumns } : {}),
      ...(Object.keys(localWidths).length > 0 ? { larghezze: localWidths } : {}),
      ...(localVistaProps && localVistaProps.length > 0 ? { proprieta: localVistaProps } : {}),
      ...(initialConfig.schema ? { schema: initialConfig.schema } : {}),
    };
  }, [initialConfig.fonte, initialConfig.schema, localColumns, localWidths, localVistaProps]);

  const fetchTableData = useCallback(async () => {
    if (!parsedBlock.ok) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await api.queryTableView({
        hostPath,
        vista: effectiveVistaForQuery,
      });
      setQueryData(res);
      setActionError(null);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [parsedBlock.ok, blockConfig, hostPath, effectiveVistaForQuery]);

  useEffect(() => {
    void fetchTableData();
  }, [fetchTableData]);

  // Se una nuova riga è stata appena creata, porta il focus sul suo titolo
  useEffect(() => {
    if (focusRowPathRef.current && queryData) {
      const target = queryData.rows.find((r) => r.path === focusRowPathRef.current);
      if (target) {
        focusRowPathRef.current = null;
        setEditingTitleRowPath(target.path);
        setTitleDraft(target.title);
      }
    }
  }, [queryData]);

  // Applica filtri e ordinamenti temporanei lato client usando il motore puro di kb-core
  const displayedRows = useMemo(() => {
    if (!queryData) return [];
    const defsMap = new Map<string, PropertyDefinition>();
    for (const col of queryData.effectiveColumns) {
      defsMap.set(col.chiave, col);
    }
    for (const s of queryData.schema) {
      defsMap.set(s.chiave, s);
    }
    const filtered = filterTableRows(queryData.rows, localFilters);
    return sortTableRows(filtered, localSorts, defsMap);
  }, [queryData, localFilters, localSorts]);

  const visibleRows = useMemo(
    () => displayedRows.slice(0, visibleLimit),
    [displayedRows, visibleLimit],
  );

  const isDatabaseBacked = Boolean(
    queryData?.sourceType === 'database' && queryData?.databaseId,
  );

  // Esegue una mutazione dello schema (su database se la fonte è un database, oppure localmente nel blocco vista)
  const applyVistaSchemaUpdate = (nextSchema: PropertyDefinition[], newAddedKey?: string) => {
    setLocalVistaProps(nextSchema);
    if (newAddedKey) {
      setLocalColumns((prev) => {
        const base =
          prev ??
          queryData?.effectiveColumns.map((c) => c.chiave) ?? ['titolo'];
        return base.includes(newAddedKey) ? base : [...base, newAddedKey];
      });
    }
    setVistaDirty(true);
  };

  // Salva la personalizzazione nel blocco ```vista ... ``` della pagina ospite
  const handleSaveVistaCustomization = async (confirmedLegacy = false) => {
    if (!onSaveVistaBlock) return;
    if (isLegacyEmbed && !confirmedLegacy) {
      setShowLegacyConvertConfirm(true);
      return;
    }
    setShowLegacyConvertConfirm(false);
    const colsToSave =
      localColumns ??
      queryData?.effectiveColumns.map((c) => c.chiave) ??
      [];
    const nextConfig: VistaBlockConfig = {
      fonte: initialConfig.fonte,
      ...(colsToSave.length > 0 ? { colonne: colsToSave } : {}),
      ...(Object.keys(localWidths).length > 0 ? { larghezze: localWidths } : {}),
      ...(localSorts.length > 0 ? { ordina: localSorts } : {}),
      ...(localFilters.length > 0 ? { filtri: localFilters } : {}),
      ...(localVistaProps && localVistaProps.length > 0 ? { proprieta: localVistaProps } : {}),
      ...(initialConfig.schema ? { schema: initialConfig.schema } : {}),
    };
    await onSaveVistaBlock(nextConfig, isLegacyEmbed);
    setVistaDirty(false);
  };

  // Creazione nuova proprietà da "+"
  const handleCreateProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPropName.trim();
    if (!trimmed) return;
    setActionError(null);
    try {
      const optsToPass =
        newPropType === 'seleziona' ||
        newPropType === 'selezione-multipla' ||
        newPropType === 'stato'
          ? newPropOptions.length > 0
            ? newPropOptions
            : createDefaultOptionsForType(newPropType)
          : undefined;

      if (isDatabaseBacked && queryData?.databaseId) {
        const res = await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'add-property',
          baseVersion: queryData.databaseVersion ?? undefined,
          nome: trimmed,
          tipo: newPropType,
          opzioni: optsToPass,
        });
        if (res.createdProperty && localColumns) {
          setLocalColumns([...localColumns, res.createdProperty.chiave]);
          setVistaDirty(true);
        }
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.schema ?? [];
        const { schema: nextSchema, created } = addPropertyToSchema(baseSchema, {
          nome: trimmed,
          tipo: newPropType,
          opzioni: optsToPass,
        });
        applyVistaSchemaUpdate(nextSchema, created.chiave);
      }

      setNewPropName('');
      setNewPropType('testo');
      setNewPropOptions([]);
      setShowAddPropPopover(false);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // Operazioni dal menu di una colonna
  const activeCol = useMemo(
    () => queryData?.effectiveColumns.find((c) => c.chiave === activeColMenuKey) ?? null,
    [queryData, activeColMenuKey],
  );

  const openColumnMenu = (col: EffectiveColumnMeta) => {
    if (activeColMenuKey === col.chiave) {
      setActiveColMenuKey(null);
      return;
    }
    setActiveColMenuKey(col.chiave);
    setColMenuTab('main');
    setColRenameInput(col.nome);
    setColDefaultInput(
      col.predefinito !== undefined && col.predefinito !== null ? String(col.predefinito) : '',
    );
    setColDecimalsInput(col.decimali !== undefined ? String(col.decimali) : '');
    setNewOptionValueInput('');
  };

  const handleRenameProperty = async () => {
    if (!activeCol) return;
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'rename-property',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: activeCol.chiave,
          nuovoNome: colRenameInput,
        });
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const next = renamePropertyInSchema(baseSchema, activeCol.chiave, colRenameInput);
        applyVistaSchemaUpdate(next);
      }
      setActiveColMenuKey(null);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleChangePropertyType = async (nuovoTipo: PropertyType) => {
    if (!activeCol) return;
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'change-type',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: activeCol.chiave,
          nuovoTipo,
        });
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const next = changePropertyTypeInSchema(baseSchema, activeCol.chiave, nuovoTipo);
        applyVistaSchemaUpdate(next);
      }
      setColMenuTab('main');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handlePreviewGenerateOptionsFromValues = async (
    targetTipo: 'seleziona' | 'selezione-multipla' | 'stato',
  ) => {
    if (!activeCol || !isDatabaseBacked || !queryData?.databaseId) return;
    try {
      setActionError(null);
      const preview = await api.executeDatabaseSchemaOp(queryData.databaseId, {
        op: 'create-options-from-values',
        chiave: activeCol.chiave,
        targetTipo,
        dryRun: true,
      });
      setPendingGenerateOptions({
        chiave: activeCol.chiave,
        targetTipo,
        generatedOptions: preview.generatedOptions ?? [],
      });
      setColMenuTab('generate-opts-confirm');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleConfirmGenerateOptionsFromValues = async () => {
    if (!pendingGenerateOptions || !queryData?.databaseId) return;
    try {
      setActionError(null);
      await api.executeDatabaseSchemaOp(queryData.databaseId, {
        op: 'create-options-from-values',
        baseVersion: queryData.databaseVersion ?? undefined,
        chiave: pendingGenerateOptions.chiave,
        targetTipo: pendingGenerateOptions.targetTipo,
        dryRun: false,
      });
      setPendingGenerateOptions(null);
      setActiveColMenuKey(null);
      await fetchTableData();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleUpdateOptions = async (nextOptions: PropertyOption[]) => {
    if (!activeCol) return;
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'update-options',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: activeCol.chiave,
          opzioni: nextOptions,
        });
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const next = updatePropertyOptionsInSchema(baseSchema, activeCol.chiave, nextOptions);
        applyVistaSchemaUpdate(next);
      }
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handlePreviewRenameOption = async (oldValue: string, newValue: string) => {
    if (!activeCol || !newValue.trim() || oldValue === newValue.trim()) return;
    if (!isDatabaseBacked || !queryData?.databaseId) {
      const opts = (activeCol.opzioni ?? []).map((o) =>
        o.valore === oldValue ? { ...o, valore: newValue.trim() } : o,
      );
      await handleUpdateOptions(opts);
      return;
    }
    try {
      setActionError(null);
      const preview = await api.executeDatabaseSchemaOp(queryData.databaseId, {
        op: 'rename-option',
        chiave: activeCol.chiave,
        vecchioValore: oldValue,
        nuovoValore: newValue.trim(),
        dryRun: true,
      });
      setPendingOptionRename({
        chiave: activeCol.chiave,
        oldValue,
        newValue: newValue.trim(),
        affectedCount: preview.affectedCount ?? 0,
        affectedPaths: preview.affectedPaths ?? [],
      });
      setColMenuTab('rename-opt-confirm');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleConfirmRenameOption = async () => {
    if (!pendingOptionRename || !queryData?.databaseId) return;
    try {
      setActionError(null);
      await api.executeDatabaseSchemaOp(queryData.databaseId, {
        op: 'rename-option',
        baseVersion: queryData.databaseVersion ?? undefined,
        chiave: pendingOptionRename.chiave,
        vecchioValore: pendingOptionRename.oldValue,
        nuovoValore: pendingOptionRename.newValue,
        dryRun: false,
      });
      setPendingOptionRename(null);
      setColMenuTab('options');
      await fetchTableData();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleSaveDefaultValue = async () => {
    if (!activeCol) return;
    let parsedDefault: unknown = colDefaultInput.trim() === '' ? undefined : colDefaultInput.trim();
    if (activeCol.tipo === 'numero' && parsedDefault !== undefined) {
      parsedDefault = Number(parsedDefault);
    } else if (activeCol.tipo === 'casella') {
      parsedDefault = colDefaultInput === 'true';
    } else if (activeCol.tipo === 'selezione-multipla' && typeof parsedDefault === 'string') {
      parsedDefault = parsedDefault
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'set-default',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: activeCol.chiave,
          predefinito: parsedDefault,
        });
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const next = setPropertyDefaultInSchema(baseSchema, activeCol.chiave, parsedDefault);
        applyVistaSchemaUpdate(next);
      }
      setColMenuTab('main');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleSaveDecimals = async () => {
    if (!activeCol) return;
    const dec = colDecimalsInput.trim() === '' ? undefined : Number(colDecimalsInput);
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'set-decimals',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: activeCol.chiave,
          decimali: dec,
        });
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const next = setPropertyDecimalsInSchema(baseSchema, activeCol.chiave, dec);
        applyVistaSchemaUpdate(next);
      }
      setColMenuTab('main');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleMoveColumn = async (direction: -1 | 1) => {
    if (!activeCol || !queryData) return;
    const currentOrder =
      localColumns ?? queryData.effectiveColumns.map((c) => c.chiave);
    const idx = currentOrder.indexOf(activeCol.chiave);
    if (idx === -1) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= currentOrder.length) return;
    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(idx, 1);
    nextOrder.splice(targetIdx, 0, moved!);
    setLocalColumns(nextOrder);
    setVistaDirty(true);

    if (isDatabaseBacked && queryData.databaseId) {
      const schemaKeys = nextOrder.filter((k) =>
        queryData.schema.some((s) => s.chiave === k),
      );
      await api
        .executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'reorder-properties',
          baseVersion: queryData.databaseVersion ?? undefined,
          orderedKeys: schemaKeys,
        })
        .catch(() => {});
      await fetchTableData();
    } else if (localVistaProps) {
      setLocalVistaProps(reorderPropertiesInSchema(localVistaProps, nextOrder));
    }
  };

  const handleHideColumnInView = (chiave: string) => {
    if (!queryData) return;
    const current =
      localColumns ?? queryData.effectiveColumns.map((c) => c.chiave);
    setLocalColumns(current.filter((k) => k !== chiave));
    setVistaDirty(true);
    setActiveColMenuKey(null);
  };

  const handlePreviewDeleteProperty = async () => {
    if (!activeCol) return;
    if (isDatabaseBacked && queryData?.databaseId) {
      try {
        const preview = await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'delete-property',
          chiave: activeCol.chiave,
          dryRun: true,
        });
        setPendingDeleteInfo({
          chiave: activeCol.chiave,
          nome: activeCol.nome,
          affectedCount: preview.affectedCount ?? 0,
        });
        setColMenuTab('delete-confirm');
      } catch (err) {
        setActionError((err as Error).message);
      }
    } else {
      setPendingDeleteInfo({
        chiave: activeCol.chiave,
        nome: activeCol.nome,
        affectedCount: 0,
      });
      setColMenuTab('delete-confirm');
    }
  };

  const handleConfirmDeleteProperty = async () => {
    if (!pendingDeleteInfo) return;
    try {
      setActionError(null);
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'delete-property',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: pendingDeleteInfo.chiave,
          dryRun: false,
        });
        if (localColumns) {
          setLocalColumns(localColumns.filter((k) => k !== pendingDeleteInfo.chiave));
        }
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.schema ?? [];
        const next = deletePropertyFromSchema(baseSchema, pendingDeleteInfo.chiave);
        setLocalVistaProps(next);
        if (localColumns) {
          setLocalColumns(localColumns.filter((k) => k !== pendingDeleteInfo.chiave));
        }
        setVistaDirty(true);
      }
      setPendingDeleteInfo(null);
      setActiveColMenuKey(null);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleRestoreUndefinedProperty = async (chiave: string, tipo: PropertyType) => {
    try {
      setActionError(null);
      const label = chiave.charAt(0).toUpperCase() + chiave.slice(1).replace(/-/g, ' ');
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'restore-undefined',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave,
          nome: label,
          tipo,
        });
        if (localColumns && !localColumns.includes(chiave)) {
          setLocalColumns([...localColumns, chiave]);
          setVistaDirty(true);
        }
        await fetchTableData();
      } else {
        const baseSchema = localVistaProps ?? queryData?.schema ?? [];
        const next = restoreUndefinedPropertyToSchema(baseSchema, {
          chiave,
          nome: label,
          tipo,
        });
        applyVistaSchemaUpdate(next, chiave);
      }
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // PATCH chirurgica di una cella del frontmatter della riga
  const handlePatchCellValue = async (
    row: TableRowItem,
    col: EffectiveColumnMeta,
    newValue: unknown,
    unset = false,
  ) => {
    try {
      setActionError(null);
      const res = await api.patchFrontmatter(
        row.path,
        col.chiave,
        newValue,
        row.version,
        unset,
      );
      setLastModifiedToast({
        path: row.path,
        historyId: res.historyId,
        summary: `${col.nome} in ${row.path}`,
      });
      setEditingCell(null);
      await fetchTableData();
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 409) {
        setActionError(
          `Conflitto di versione (409) sulla pagina "${row.path}". Ricarico i dati aggiornati.`,
        );
        await fetchTableData();
      } else {
        setActionError(e.message);
      }
    }
  };

  // Creazione di un'opzione al volo direttamente dalla cella (per seleziona / selezione-multipla)
  const handleCreateOptionInCell = async (
    row: TableRowItem,
    col: EffectiveColumnMeta,
    rawVal: string,
  ) => {
    const val = rawVal.trim();
    if (!val) return;
    const existingOpts = col.opzioni ?? [];
    const nextColor =
      PROPERTY_COLORS[existingOpts.length % PROPERTY_COLORS.length] ?? 'grigio';
    const nextOpt: PropertyOption = {
      valore: val,
      colore: nextColor,
      ...(col.tipo === 'stato' ? { gruppo: 'da-fare' as StatusGroup } : {}),
    };
    const updatedOpts = [...existingOpts, nextOpt];

    try {
      if (isDatabaseBacked && queryData?.databaseId) {
        await api.executeDatabaseSchemaOp(queryData.databaseId, {
          op: 'update-options',
          baseVersion: queryData.databaseVersion ?? undefined,
          chiave: col.chiave,
          opzioni: updatedOpts,
        });
      } else {
        const baseSchema = localVistaProps ?? queryData?.effectiveColumns ?? [];
        const hasDef = baseSchema.some((p) => p.chiave === col.chiave);
        const nextSchema = hasDef
          ? updatePropertyOptionsInSchema(baseSchema, col.chiave, updatedOpts)
          : [...baseSchema, { ...col, opzioni: updatedOpts }];
        setLocalVistaProps(nextSchema);
        setVistaDirty(true);
      }

      if (col.tipo === 'selezione-multipla') {
        const curList = Array.isArray(getRowCellValue(row, col.chiave))
          ? (getRowCellValue(row, col.chiave) as unknown[]).map(String)
          : [];
        const nextList = curList.includes(val) ? curList : [...curList, val];
        await handlePatchCellValue(row, col, nextList);
      } else {
        await handlePatchCellValue(row, col, val);
      }
      setCellOptionSearch('');
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // Rinomina titolo di una riga
  const handleCommitRowTitle = async (row: TableRowItem) => {
    const nextTitle = titleDraft.trim();
    setEditingTitleRowPath(null);
    if (!nextTitle || nextTitle === row.title) return;
    try {
      setActionError(null);
      const slash = row.managePath.lastIndexOf('/');
      const parentDir = slash === -1 ? '' : row.managePath.slice(0, slash + 1);
      const destPath = row.isNode
        ? `${parentDir}${nextTitle}`
        : `${parentDir}${nextTitle}.md`;
      await api.rename(row.managePath, destPath);
      await fetchTableData();
      await onTreeMutated?.();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // "+ Nuova riga"
  const handleAddRow = async () => {
    if (!queryData || !queryData.canAddRow) return;
    try {
      setActionError(null);
      if (queryData.sourceType === 'database' && queryData.databaseId) {
        const res = await api.createDatabaseRow(queryData.databaseId, {
          title: 'Nuova riga',
        });
        focusRowPathRef.current = res.created.file.path;
        await fetchTableData();
        await onTreeMutated?.();
      } else if (queryData.sourceType === 'sottopagine') {
        const res = await api.createSubpage(hostPath, 'Nuova pagina');
        focusRowPathRef.current = res.created.file.path;
        await fetchTableData();
        await onTreeMutated?.(res.convertedParent);
      }
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // Archiviazione riga con conferma (mai cancellazione!)
  const handleConfirmArchiveRow = async () => {
    if (!confirmArchiveRow) return;
    try {
      setActionError(null);
      await api.archive(confirmArchiveRow.managePath);
      setConfirmArchiveRow(null);
      await fetchTableData();
      await onTreeMutated?.();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // Annulla l'ultima modifica al frontmatter della riga
  const handleUndoLastCellPatch = async () => {
    if (!lastModifiedToast || !lastModifiedToast.historyId) return;
    try {
      await api.restoreHistory(lastModifiedToast.path, lastModifiedToast.historyId);
      setLastModifiedToast(null);
      await fetchTableData();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  // Se il blocco YAML è invalido, mostra un segnaposto chiaro senza toccare il testo originale
  if (!parsedBlock.ok) {
    return (
      <div className="notion-vista-error-box">
        <div className="notion-vista-error-header">
          <AlertTriangle size={16} />
          <strong>Blocco vista non valido</strong>
          {onEditRawYaml && (
            <button
              type="button"
              className="notion-vista-btn"
              onClick={onEditRawYaml}
            >
              <Code size={13} /> Modifica YAML
            </button>
          )}
        </div>
        <p className="notion-vista-error-msg">{parsedBlock.error}</p>
        {rawBlock && <pre className="notion-vista-raw-preview">{rawBlock}</pre>}
      </div>
    );
  }

  // Se il database non esiste o la fonte non è risolvibile
  if (queryData?.error) {
    return (
      <div className="notion-vista-error-box">
        <div className="notion-vista-error-header">
          <AlertTriangle size={16} />
          <strong>Impossibile caricare la vista a tabella</strong>
          {onEditRawYaml && (
            <button
              type="button"
              className="notion-vista-btn"
              onClick={onEditRawYaml}
            >
              <Code size={13} /> Modifica YAML
            </button>
          )}
        </div>
        <p className="notion-vista-error-msg">{queryData.error}</p>
        {rawBlock && <pre className="notion-vista-raw-preview">{rawBlock}</pre>}
      </div>
    );
  }

  const columnsToRender = (queryData?.effectiveColumns ?? []).filter(
    (c) => c.chiave !== 'titolo',
  );

  const toggleColumnSort = (chiave: string) => {
    setLocalSorts((prev) => {
      const existing = prev.find((s) => s.proprieta === chiave);
      if (!existing) {
        setVistaDirty(true);
        return [{ proprieta: chiave, direzione: 'asc' }];
      }
      if (existing.direzione === 'asc') {
        setVistaDirty(true);
        return prev.map((s) =>
          s.proprieta === chiave ? { ...s, direzione: 'desc' } : s,
        );
      }
      setVistaDirty(true);
      return prev.filter((s) => s.proprieta !== chiave);
    });
  };

  const openCellEditor = (row: TableRowItem, col: EffectiveColumnMeta) => {
    if (col.computed && col.chiave !== 'tag') return;
    if (col.tipo === 'creato' || col.tipo === 'modificato') return;
    const rawVal = getRowCellValue(row, col.chiave);
    setEditingCell({ rowPath: row.path, colKey: col.chiave });
    setCellOptionSearch('');

    if (col.tipo === 'data') {
      const parsedDate = typeof rawVal === 'string' ? rawVal.trim() : '';
      const [startPart, endPart] = parsedDate.split('/');
      const [dateOnly, timeOnly] = (startPart ?? '').split('T');
      setDateStartDraft(dateOnly || new Date().toISOString().slice(0, 10));
      setDateTimeDraft(timeOnly || '');
      setDateHasEndDraft(Boolean(endPart));
      setDateEndDraft(endPart ? endPart.split('T')[0] ?? '' : '');
    } else {
      setCellDraftText(rawVal !== null && rawVal !== undefined ? String(rawVal) : '');
    }
  };

  return (
    <div
      className={`notion-table-view-widget ${fullPageDatabase ? 'is-full-page' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Barra superiore della vista */}
      <div className="notion-table-toolbar">
        <div className="notion-table-toolbar-left">
          <span className="notion-table-source-badge">
            {queryData?.sourceType === 'database'
              ? queryData.databaseName || 'Database'
              : `Indice (${queryData?.sourceType ?? initialConfig.fonte})`}
          </span>
          {queryData?.databasePath && !fullPageDatabase && (
            <button
              type="button"
              className="notion-vista-btn-ghost"
              title="Apri la pagina del database"
              onClick={() => onOpenPage(queryData.databasePath!)}
            >
              <ExternalLink size={13} /> Apri database
            </button>
          )}
        </div>

        <div className="notion-table-toolbar-actions">
          <button
            type="button"
            className={`notion-vista-btn-ghost ${localFilters.length > 0 ? 'is-active' : ''}`}
            onClick={() => setShowFilterBar((v) => !v)}
          >
            <Filter size={13} /> Filtra
            {localFilters.length > 0 && (
              <span className="notion-vista-pill-count">{localFilters.length}</span>
            )}
          </button>

          <button
            type="button"
            className={`notion-vista-btn-ghost ${localSorts.length > 0 ? 'is-active' : ''}`}
            onClick={() => setShowSortBar((v) => !v)}
          >
            <ListFilter size={13} /> Ordina
            {localSorts.length > 0 && (
              <span className="notion-vista-pill-count">{localSorts.length}</span>
            )}
          </button>

          {/* Selettore Colonne */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="notion-vista-btn-ghost"
              onClick={() => setShowColumnsPopover((v) => !v)}
            >
              <SlidersHorizontal size={13} /> Proprietà
            </button>
            {showColumnsPopover && queryData && (
              <div className="notion-table-popover" style={{ right: 0, top: '100%' }}>
                <div className="notion-table-popover-header">
                  <span>Colonne nella vista</span>
                  <button
                    type="button"
                    className="notion-icon-btn"
                    onClick={() => setShowColumnsPopover(false)}
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="notion-table-popover-list">
                  {[
                    ...queryData.schema,
                    ...queryData.undefinedFields.map((uf) => ({
                      chiave: uf.chiave,
                      nome: uf.chiave.charAt(0).toUpperCase() + uf.chiave.slice(1).replace(/-/g, ' '),
                      tipo: uf.inferredType,
                    })),
                    { chiave: 'tag', nome: 'Tag', tipo: 'selezione-multipla' as const },
                    { chiave: 'creato', nome: 'Creato il', tipo: 'creato' as const },
                    { chiave: 'modificato', nome: 'Modificato il', tipo: 'modificato' as const },
                    { chiave: 'percorso', nome: 'Percorso', tipo: 'testo' as const },
                  ]
                    .filter(
                      (item, index, arr) =>
                        arr.findIndex((x) => x.chiave.toLowerCase() === item.chiave.toLowerCase()) === index,
                    )
                    .map((prop) => {
                      const activeCols =
                        localColumns ??
                        queryData.effectiveColumns.map((c) => c.chiave);
                      const isShown = activeCols.includes(prop.chiave);
                      return (
                        <label key={prop.chiave} className="notion-popover-check-row">
                          <input
                            type="checkbox"
                            checked={isShown}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...activeCols, prop.chiave]
                                : activeCols.filter((k) => k !== prop.chiave);
                              setLocalColumns(next);
                              setVistaDirty(true);
                              if (
                                e.target.checked &&
                                queryData.undefinedFields.some((u) => u.chiave === prop.chiave)
                              ) {
                                void handleRestoreUndefinedProperty(prop.chiave, prop.tipo);
                              }
                            }}
                          />
                          {renderPropertyTypeIcon(prop.tipo, 13)}
                          <span>{prop.nome}</span>
                        </label>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          {/* Pulsante Salva Vista */}
          {vistaDirty && onSaveVistaBlock && (
            <button
              type="button"
              className="notion-vista-btn is-primary"
              onClick={() => void handleSaveVistaCustomization(false)}
              title="Scrive colonne, ordinamento, filtri e larghezze nel blocco vista della pagina"
            >
              <Save size={13} /> Salva vista
            </button>
          )}

          {/* Pulsante Modifica YAML */}
          {onEditRawYaml && !fullPageDatabase && (
            <button
              type="button"
              className="notion-vista-btn-ghost"
              onClick={onEditRawYaml}
              title="Posiziona il cursore nel blocco YAML per modificarlo come testo"
            >
              <Code size={13} /> YAML
            </button>
          )}
        </div>
      </div>

      {/* Conferma conversione esplicita da sintassi legacy ![[page:p_...]] a blocco ```vista */}
      {showLegacyConvertConfirm && (
        <div className="notion-table-warning-banner">
          <AlertTriangle size={14} />
          <span>
            Stai salvando una personalizzazione su un blocco legacy <code>![[page:...]]</code>.
            Verrà convertito in un blocco <code>```vista</code> (con snapshot nello storico).
          </span>
          <button
            type="button"
            className="notion-vista-btn is-primary"
            onClick={() => void handleSaveVistaCustomization(true)}
          >
            Conferma e salva
          </button>
          <button
            type="button"
            className="notion-vista-btn"
            onClick={() => setShowLegacyConvertConfirm(false)}
          >
            Annulla
          </button>
        </div>
      )}

      {/* Notifica modifica pagina riga con Annulla */}
      {lastModifiedToast && (
        <div className="notion-table-toast-banner">
          <span>
            Modificata pagina: <code>{lastModifiedToast.path}</code>
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {lastModifiedToast.historyId && (
              <button
                type="button"
                className="notion-vista-btn"
                onClick={() => void handleUndoLastCellPatch()}
              >
                <RotateCcw size={12} /> Annulla
              </button>
            )}
            <button
              type="button"
              className="notion-icon-btn"
              onClick={() => setLastModifiedToast(null)}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="notion-table-error-banner">
          <AlertTriangle size={14} />
          <span>{actionError}</span>
          <button
            type="button"
            className="notion-icon-btn"
            onClick={() => setActionError(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Barra Filtri Temporanei (in AND) */}
      {showFilterBar && queryData && (
        <div className="notion-table-subbar">
          <span className="notion-subbar-label">Filtri (AND):</span>
          {localFilters.map((flt, idx) => {
            const opMeta = FILTER_OPERATOR_META.find((m) => m.op === flt.operatore);
            return (
              <div key={idx} className="notion-filter-chip">
                <select
                  value={flt.proprieta}
                  onChange={(e) => {
                    const next = [...localFilters];
                    next[idx] = { ...flt, proprieta: e.target.value };
                    setLocalFilters(next);
                    setVistaDirty(true);
                  }}
                >
                  <option value="titolo">Titolo</option>
                  {columnsToRender.map((c) => (
                    <option key={c.chiave} value={c.chiave}>
                      {c.nome}
                    </option>
                  ))}
                </select>
                <select
                  value={flt.operatore}
                  onChange={(e) => {
                    const next = [...localFilters];
                    next[idx] = { ...flt, operatore: e.target.value as FilterOperator };
                    setLocalFilters(next);
                    setVistaDirty(true);
                  }}
                >
                  {FILTER_OPERATOR_META.map((m) => (
                    <option key={m.op} value={m.op}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {opMeta?.needsValue !== false && (
                  <input
                    type="text"
                    placeholder="Valore..."
                    value={flt.valore !== undefined && flt.valore !== null ? String(flt.valore) : ''}
                    onChange={(e) => {
                      const next = [...localFilters];
                      next[idx] = { ...flt, valore: e.target.value };
                      setLocalFilters(next);
                      setVistaDirty(true);
                    }}
                  />
                )}
                <button
                  type="button"
                  className="notion-icon-btn"
                  onClick={() => {
                    setLocalFilters(localFilters.filter((_, i) => i !== idx));
                    setVistaDirty(true);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="notion-vista-btn-ghost"
            onClick={() => {
              const firstProp = columnsToRender[0]?.chiave ?? 'titolo';
              setLocalFilters([
                ...localFilters,
                { proprieta: firstProp, operatore: 'contiene', valore: '' },
              ]);
              setVistaDirty(true);
            }}
          >
            <Plus size={12} /> Aggiungi filtro
          </button>
        </div>
      )}

      {/* Barra Ordinamento Temporaneo */}
      {showSortBar && queryData && (
        <div className="notion-table-subbar">
          <span className="notion-subbar-label">Ordina per:</span>
          {localSorts.map((srt, idx) => (
            <div key={idx} className="notion-filter-chip">
              <select
                value={srt.proprieta}
                onChange={(e) => {
                  const next = [...localSorts];
                  next[idx] = { ...srt, proprieta: e.target.value };
                  setLocalSorts(next);
                  setVistaDirty(true);
                }}
              >
                <option value="titolo">Titolo</option>
                {columnsToRender.map((c) => (
                  <option key={c.chiave} value={c.chiave}>
                    {c.nome}
                  </option>
                ))}
              </select>
              <select
                value={srt.direzione}
                onChange={(e) => {
                  const next = [...localSorts];
                  next[idx] = { ...srt, direzione: e.target.value as 'asc' | 'desc' };
                  setLocalSorts(next);
                  setVistaDirty(true);
                }}
              >
                <option value="asc">Crescente (A → Z)</option>
                <option value="desc">Decrescente (Z → A)</option>
              </select>
              <button
                type="button"
                className="notion-icon-btn"
                onClick={() => {
                  setLocalSorts(localSorts.filter((_, i) => i !== idx));
                  setVistaDirty(true);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="notion-vista-btn-ghost"
            onClick={() => {
              const firstProp = columnsToRender[0]?.chiave ?? 'titolo';
              setLocalSorts([
                ...localSorts,
                { proprieta: firstProp, direzione: 'asc' },
              ]);
              setVistaDirty(true);
            }}
          >
            <Plus size={12} /> Aggiungi criterio
          </button>
        </div>
      )}

      {/* Contenitore Tabella con scorrimento orizzontale e intestazione fissa */}
      <div className="notion-table-scroll-container">
        <table className="notion-data-table">
          <thead>
            <tr>
              {/* Prima colonna fissa: Nome della nota */}
              <th
                className="notion-th-title"
                style={{
                  width: localWidths.titolo ?? 260,
                  minWidth: 200,
                }}
              >
                <div
                  className="notion-th-inner"
                  onClick={() => toggleColumnSort('titolo')}
                  title="Nome della nota"
                >
                  <FileText size={14} />
                  <span>Nome</span>
                  {localSorts.find((s) => s.proprieta === 'titolo')?.direzione === 'asc' && (
                    <ArrowUp size={12} />
                  )}
                  {localSorts.find((s) => s.proprieta === 'titolo')?.direzione === 'desc' && (
                    <ArrowDown size={12} />
                  )}
                </div>
              </th>

              {/* Colonne delle proprietà */}
              {columnsToRender.map((col) => {
                const sortEntry = localSorts.find((s) => s.proprieta === col.chiave);
                const colWidth = localWidths[col.chiave] ?? col.width ?? 180;
                const isMenuOpen = activeColMenuKey === col.chiave;
                return (
                  <th
                    key={col.chiave}
                    className="notion-th-prop"
                    style={{ width: colWidth, minWidth: 130, position: 'relative' }}
                  >
                    <div
                      className="notion-th-inner"
                      onClick={() => openColumnMenu(col)}
                    >
                      <span className="notion-th-icon">
                        {renderPropertyTypeIcon(col.tipo, 14)}
                      </span>
                      <span className="notion-th-name" title={`${col.nome} (${col.chiave})`}>
                        {col.nome}
                      </span>
                      {sortEntry?.direzione === 'asc' && <ArrowUp size={12} />}
                      {sortEntry?.direzione === 'desc' && <ArrowDown size={12} />}
                    </div>

                    {/* Menu contestuale della colonna */}
                    {isMenuOpen && activeCol && (
                      <div
                        className="notion-table-popover notion-col-menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {colMenuTab === 'main' && (
                          <>
                            <div className="notion-col-menu-title">
                              {renderPropertyTypeIcon(activeCol.tipo, 14)}
                              <strong>{activeCol.nome}</strong>
                              <code className="notion-col-slug">{activeCol.chiave}</code>
                            </div>

                            <button
                              type="button"
                              className="notion-menu-item"
                              onClick={() => toggleColumnSort(activeCol.chiave)}
                            >
                              <ArrowUp size={13} /> Ordina crescente / decrescente
                            </button>

                            {!activeCol.computed && (
                              <>
                                <button
                                  type="button"
                                  className="notion-menu-item"
                                  onClick={() => setColMenuTab('rename')}
                                >
                                  <Type size={13} /> Rinomina proprietà
                                </button>
                                <button
                                  type="button"
                                  className="notion-menu-item"
                                  onClick={() => setColMenuTab('type')}
                                >
                                  <SlidersHorizontal size={13} /> Cambia tipo ({getPropertyTypeLabel(activeCol.tipo)})
                                </button>
                                {(activeCol.tipo === 'seleziona' ||
                                  activeCol.tipo === 'selezione-multipla' ||
                                  activeCol.tipo === 'stato') && (
                                  <button
                                    type="button"
                                    className="notion-menu-item"
                                    onClick={() => setColMenuTab('options')}
                                  >
                                    <List size={13} /> Modifica opzioni ({activeCol.opzioni?.length ?? 0})
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="notion-menu-item"
                                  onClick={() => setColMenuTab('default')}
                                >
                                  <Check size={13} /> Valore predefinito
                                </button>
                                {activeCol.tipo === 'numero' && (
                                  <button
                                    type="button"
                                    className="notion-menu-item"
                                    onClick={() => setColMenuTab('decimals')}
                                  >
                                    <Hash size={13} /> Decimali ({activeCol.decimali ?? 'auto'})
                                  </button>
                                )}
                              </>
                            )}

                            <div className="notion-menu-divider" />
                            <button
                              type="button"
                              className="notion-menu-item"
                              onClick={() => void handleMoveColumn(-1)}
                            >
                              <ArrowLeft size={13} /> Sposta a sinistra
                            </button>
                            <button
                              type="button"
                              className="notion-menu-item"
                              onClick={() => void handleMoveColumn(1)}
                            >
                              <ArrowRight size={13} /> Sposta a destra
                            </button>
                            <button
                              type="button"
                              className="notion-menu-item"
                              onClick={() => handleHideColumnInView(activeCol.chiave)}
                            >
                              <EyeOff size={13} /> Nascondi in questa vista
                            </button>
                            {!activeCol.computed && (
                              <button
                                type="button"
                                className="notion-menu-item is-danger"
                                onClick={() => void handlePreviewDeleteProperty()}
                              >
                                <Trash2 size={13} /> Elimina proprietà
                              </button>
                            )}
                          </>
                        )}

                        {colMenuTab === 'rename' && (
                          <div className="notion-col-submenu">
                            <label className="notion-submenu-label">
                              Nuova etichetta (la chiave <code>{activeCol.chiave}</code> resta invariata):
                            </label>
                            <input
                              type="text"
                              className="notion-input"
                              maxLength={60}
                              value={colRenameInput}
                              onChange={(e) => setColRenameInput(e.target.value)}
                              autoFocus
                            />
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => void handleRenameProperty()}
                              >
                                Salva
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => setColMenuTab('main')}
                              >
                                Indietro
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'type' && (
                          <div className="notion-col-submenu">
                            <label className="notion-submenu-label">
                              Cambia tipo colonna (testo, numero, data, selezione multipla):
                            </label>
                            <div className="notion-type-grid">
                              {PRIMARY_PROPERTY_TYPE_META.map((m) => (
                                <button
                                  key={m.type}
                                  type="button"
                                  className={`notion-type-grid-btn ${activeCol.tipo === m.type ? 'is-selected' : ''}`}
                                  onClick={() => void handleChangePropertyType(m.type)}
                                >
                                  {renderPropertyTypeIcon(m.type, 14)}
                                  <span>{m.label}</span>
                                </button>
                              ))}
                            </div>
                            {isDatabaseBacked && (
                              <div style={{ marginTop: 8 }}>
                                <span className="notion-submenu-label">
                                  Oppure genera opzioni dai valori esistenti:
                                </span>
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                                  <button
                                    type="button"
                                    className="notion-vista-btn"
                                    onClick={() =>
                                      void handlePreviewGenerateOptionsFromValues('seleziona')
                                    }
                                  >
                                    → Seleziona
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-vista-btn"
                                    onClick={() =>
                                      void handlePreviewGenerateOptionsFromValues('selezione-multipla')
                                    }
                                  >
                                    → Multipla
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-vista-btn"
                                    onClick={() =>
                                      void handlePreviewGenerateOptionsFromValues('stato')
                                    }
                                  >
                                    → Stato
                                  </button>
                                </div>
                              </div>
                            )}
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => setColMenuTab('main')}
                              >
                                Indietro
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'generate-opts-confirm' && pendingGenerateOptions && (
                          <div className="notion-col-submenu">
                            <p className="notion-popover-help">
                              Verranno create{' '}
                              <strong>{pendingGenerateOptions.generatedOptions.length}</strong>{' '}
                              opzioni dai valori esistenti nelle righe:
                            </p>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '6px 0' }}>
                              {pendingGenerateOptions.generatedOptions.map((o) => (
                                <React.Fragment key={o.valore}>
                                  {renderOptionPill(
                                    o.valore,
                                    o,
                                    pendingGenerateOptions.targetTipo === 'stato',
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => void handleConfirmGenerateOptionsFromValues()}
                              >
                                Conferma
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => {
                                  setPendingGenerateOptions(null);
                                  setColMenuTab('type');
                                }}
                              >
                                Annulla
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'options' && (
                          <div className="notion-col-submenu" style={{ minWidth: 290 }}>
                            <label className="notion-submenu-label">
                              Opzioni ({activeCol.opzioni?.length ?? 0}/100):
                            </label>
                            <div className="notion-options-editor-list">
                              {(activeCol.opzioni ?? []).map((opt, idx) => (
                                <div key={opt.valore} className="notion-option-edit-row">
                                  {renderOptionPill(
                                    opt.valore,
                                    opt,
                                    activeCol.tipo === 'stato',
                                  )}
                                  <select
                                    value={opt.colore}
                                    title="Colore opzione"
                                    onChange={(e) => {
                                      const next = [...(activeCol.opzioni ?? [])];
                                      next[idx] = {
                                        ...opt,
                                        colore: e.target.value as PropertyColor,
                                      };
                                      void handleUpdateOptions(next);
                                    }}
                                  >
                                    {PROPERTY_COLORS.map((c) => (
                                      <option key={c} value={c}>
                                        {COLOR_PALETTE_META[c].label}
                                      </option>
                                    ))}
                                  </select>
                                  {activeCol.tipo === 'stato' && (
                                    <select
                                      value={opt.gruppo ?? 'da-fare'}
                                      title="Gruppo stato"
                                      onChange={(e) => {
                                        const next = [...(activeCol.opzioni ?? [])];
                                        next[idx] = {
                                          ...opt,
                                          gruppo: e.target.value as StatusGroup,
                                        };
                                        void handleUpdateOptions(next);
                                      }}
                                    >
                                      {STATUS_GROUPS.map((g) => (
                                        <option key={g} value={g}>
                                          {STATUS_GROUP_LABELS[g]}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                  <button
                                    type="button"
                                    className="notion-icon-btn"
                                    title="Rinomina valore opzione (con anteprima pagine)"
                                    onClick={() => {
                                      const nextVal = window.prompt(
                                        `Rinomina l'opzione "${opt.valore}" in:`,
                                        opt.valore,
                                      );
                                      if (nextVal && nextVal.trim() !== opt.valore) {
                                        void handlePreviewRenameOption(opt.valore, nextVal.trim());
                                      }
                                    }}
                                  >
                                    <Type size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-icon-btn"
                                    title="Elimina opzione dalla definizione (il testo nelle righe resta intatto)"
                                    onClick={() => {
                                      const next = (activeCol.opzioni ?? []).filter(
                                        (_, i) => i !== idx,
                                      );
                                      void handleUpdateOptions(next);
                                    }}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>

                            <div className="notion-option-add-bar">
                              <input
                                type="text"
                                className="notion-input"
                                placeholder="Nuova opzione..."
                                value={newOptionValueInput}
                                onChange={(e) => setNewOptionValueInput(e.target.value)}
                              />
                              {activeCol.tipo === 'stato' && (
                                <select
                                  value={newOptionGroupInput}
                                  onChange={(e) =>
                                    setNewOptionGroupInput(e.target.value as StatusGroup)
                                  }
                                >
                                  {STATUS_GROUPS.map((g) => (
                                    <option key={g} value={g}>
                                      {STATUS_GROUP_LABELS[g]}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => {
                                  const v = newOptionValueInput.trim();
                                  if (!v) return;
                                  const cur = activeCol.opzioni ?? [];
                                  const colChoice =
                                    PROPERTY_COLORS[cur.length % PROPERTY_COLORS.length] ??
                                    'grigio';
                                  void handleUpdateOptions([
                                    ...cur,
                                    {
                                      valore: v,
                                      colore: colChoice,
                                      ...(activeCol.tipo === 'stato'
                                        ? { gruppo: newOptionGroupInput }
                                        : {}),
                                    },
                                  ]);
                                  setNewOptionValueInput('');
                                }}
                              >
                                <Plus size={12} />
                              </button>
                            </div>

                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => setColMenuTab('main')}
                              >
                                Chiudi
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'rename-opt-confirm' && pendingOptionRename && (
                          <div className="notion-col-submenu">
                            <p className="notion-popover-help">
                              Rinominando <strong>{pendingOptionRename.oldValue}</strong> in{' '}
                              <strong>{pendingOptionRename.newValue}</strong> verranno modificate{' '}
                              <strong>{pendingOptionRename.affectedCount}</strong>{' '}
                              {pendingOptionRename.affectedCount === 1 ? 'pagina' : 'pagine'} (con
                              snapshot nello storico).
                            </p>
                            {pendingOptionRename.affectedPaths.length > 0 && (
                              <ul className="notion-affected-paths-list">
                                {pendingOptionRename.affectedPaths.slice(0, 6).map((p) => (
                                  <li key={p}>
                                    <code>{p}</code>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => void handleConfirmRenameOption()}
                              >
                                Conferma ({pendingOptionRename.affectedCount})
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => {
                                  setPendingOptionRename(null);
                                  setColMenuTab('options');
                                }}
                              >
                                Annulla
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'default' && (
                          <div className="notion-col-submenu">
                            <label className="notion-submenu-label">
                              Valore predefinito per le nuove righe:
                            </label>
                            <input
                              type="text"
                              className="notion-input"
                              placeholder="Vuoto = nessun predefinito"
                              value={colDefaultInput}
                              onChange={(e) => setColDefaultInput(e.target.value)}
                            />
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => void handleSaveDefaultValue()}
                              >
                                Salva
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => setColMenuTab('main')}
                              >
                                Indietro
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'decimals' && (
                          <div className="notion-col-submenu">
                            <label className="notion-submenu-label">
                              Cifre decimali (0 - 6, vuoto = automatico):
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={6}
                              className="notion-input"
                              value={colDecimalsInput}
                              onChange={(e) => setColDecimalsInput(e.target.value)}
                            />
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-primary"
                                onClick={() => void handleSaveDecimals()}
                              >
                                Salva
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => setColMenuTab('main')}
                              >
                                Indietro
                              </button>
                            </div>
                          </div>
                        )}

                        {colMenuTab === 'delete-confirm' && pendingDeleteInfo && (
                          <div className="notion-col-submenu">
                            <p className="notion-popover-help">
                              Eliminare la definizione di{' '}
                              <strong>{pendingDeleteInfo.nome}</strong>?{' '}
                              {pendingDeleteInfo.affectedCount > 0 ? (
                                <>
                                  <strong>{pendingDeleteInfo.affectedCount}</strong>{' '}
                                  {pendingDeleteInfo.affectedCount === 1
                                    ? 'riga ha'
                                    : 'righe hanno'}{' '}
                                  un valore per questa proprietà: i valori{' '}
                                  <strong>non verranno cancellati</strong> dai file e resteranno
                                  come campi non definiti.
                                </>
                              ) : (
                                'Nessuna riga contiene valori per questa proprietà.'
                              )}
                            </p>
                            <div className="notion-submenu-actions">
                              <button
                                type="button"
                                className="notion-vista-btn is-danger"
                                onClick={() => void handleConfirmDeleteProperty()}
                              >
                                Elimina definizione
                              </button>
                              <button
                                type="button"
                                className="notion-vista-btn"
                                onClick={() => {
                                  setPendingDeleteInfo(null);
                                  setColMenuTab('main');
                                }}
                              >
                                Annulla
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </th>
                );
              })}

              {/* Pulsante "+" nell'intestazione per creare una nuova proprietà */}
              <th className="notion-th-add" style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="notion-th-add-btn"
                  title="Aggiungi proprietà alla tabella"
                  onClick={() => setShowAddPropPopover((v) => !v)}
                >
                  <Plus size={15} />
                </button>

                {showAddPropPopover && (
                  <form
                    className="notion-table-popover notion-add-prop-popover"
                    onSubmit={(e) => void handleCreateProperty(e)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="notion-table-popover-header">
                      <span>Nuova colonna</span>
                      <button
                        type="button"
                        className="notion-icon-btn"
                        onClick={() => setShowAddPropPopover(false)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <input
                      type="text"
                      className="notion-input"
                      placeholder="Nome colonna (es. Persone, Priorità, Scadenza, Note)..."
                      maxLength={60}
                      value={newPropName}
                      onChange={(e) => setNewPropName(e.target.value)}
                      autoFocus
                    />

                    <label className="notion-submenu-label" style={{ marginTop: 8, display: 'block' }}>
                      Tipo colonna:
                    </label>

                    <div className="notion-type-grid">
                      {PRIMARY_PROPERTY_TYPE_META.map((m) => (
                        <button
                          key={m.type}
                          type="button"
                          className={`notion-type-grid-btn ${newPropType === m.type ? 'is-selected' : ''}`}
                          onClick={() => {
                            setNewPropType(m.type);
                            if (m.type === 'selezione-multipla') {
                              setNewPropOptions(createDefaultOptionsForType(m.type));
                            } else {
                              setNewPropOptions([]);
                            }
                          }}
                        >
                          {renderPropertyTypeIcon(m.type, 14)}
                          <span>{m.label}</span>
                        </button>
                      ))}
                    </div>

                    {/* Editor opzioni iniziali se il tipo lo prevede */}
                    {newPropType === 'selezione-multipla' && (
                      <div className="notion-new-prop-options">
                        <span className="notion-submenu-label">Opzioni iniziali:</span>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '4px 0' }}>
                          {newPropOptions.map((o, i) => (
                            <span
                              key={o.valore}
                              onClick={() =>
                                setNewPropOptions(newPropOptions.filter((_, idx) => idx !== i))
                              }
                              style={{ cursor: 'pointer' }}
                              title="Clicca per rimuovere"
                            >
                              {renderOptionPill(o.valore, o, false)}
                            </span>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input
                            type="text"
                            className="notion-input"
                            placeholder="Aggiungi opzione..."
                            value={newOptDraft}
                            onChange={(e) => setNewOptDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const v = newOptDraft.trim();
                                if (!v) return;
                                const color =
                                  PROPERTY_COLORS[newPropOptions.length % PROPERTY_COLORS.length] ??
                                  'grigio';
                                setNewPropOptions([
                                  ...newPropOptions,
                                  {
                                    valore: v,
                                    colore: color,
                                  },
                                ]);
                                setNewOptDraft('');
                              }
                            }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="notion-submenu-actions" style={{ marginTop: 8 }}>
                      <button
                        type="submit"
                        className="notion-vista-btn is-primary"
                        disabled={!newPropName.trim()}
                      >
                        Crea colonna
                      </button>
                    </div>
                  </form>
                )}
              </th>
            </tr>
          </thead>

          <tbody>
            {loading && !queryData ? (
              <tr>
                <td colSpan={columnsToRender.length + 2} className="notion-table-empty-cell">
                  Caricamento vista a tabella...
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columnsToRender.length + 2} className="notion-table-empty-cell">
                  Nessuna riga presente in questa vista.
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
                <tr key={row.path} className="notion-table-row">
                  {/* Cella Titolo con icona, modifica inline, pulsante "Apri" su hover e "Archivia" */}
                  <td className="notion-td-title">
                    <div className="notion-title-cell-inner">
                      <span className="notion-row-page-icon">
                        {row.isNode ? <FolderOpen size={14} /> : <FileText size={14} />}
                      </span>
                      {editingTitleRowPath === row.path ? (
                        <input
                          type="text"
                          className="notion-inline-cell-input"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={() => void handleCommitRowTitle(row)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCommitRowTitle(row);
                            if (e.key === 'Escape') setEditingTitleRowPath(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="notion-row-title-text"
                          onClick={() => {
                            setEditingTitleRowPath(row.path);
                            setTitleDraft(row.title);
                          }}
                        >
                          {row.title}
                        </span>
                      )}

                      <div className="notion-row-hover-actions">
                        <button
                          type="button"
                          className="notion-row-open-btn"
                          onClick={() => onOpenPage(row.path)}
                          title={`Apri pagina (${row.path})`}
                        >
                          <ExternalLink size={12} /> Apri
                        </button>
                        <button
                          type="button"
                          className="notion-icon-btn"
                          onClick={() => setConfirmArchiveRow(row)}
                          title="Archivia riga (sposta in archivio senza cancellare)"
                        >
                          <Archive size={12} />
                        </button>
                      </div>
                    </div>
                  </td>

                  {/* Celle delle proprietà */}
                  {columnsToRender.map((col) => {
                    const rawVal = getRowCellValue(row, col.chiave);
                    const warningMsg = row.warnings[col.chiave];
                    const isEditing =
                      editingCell?.rowPath === row.path &&
                      editingCell?.colKey === col.chiave;

                    // Casella (checkbox cliccabile direttamente)
                    if (col.tipo === 'casella' && !warningMsg) {
                      return (
                        <td key={col.chiave} className="notion-td-cell is-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(rawVal)}
                            onChange={(e) =>
                              void handlePatchCellValue(row, col, e.target.checked)
                            }
                          />
                        </td>
                      );
                    }

                    return (
                      <td
                        key={col.chiave}
                        className={`notion-td-cell ${col.tipo === 'numero' ? 'is-number' : ''} ${warningMsg ? 'has-warning' : ''}`}
                        onClick={() => {
                          if (!isEditing) openCellEditor(row, col);
                        }}
                      >
                        {/* Modalità visualizzazione cella */}
                        {!isEditing && (
                          <div className="notion-cell-display">
                            {warningMsg ? (
                              <span
                                className="notion-cell-warning-badge"
                                title={warningMsg}
                              >
                                <AlertTriangle size={12} />
                                <span>{formatRawValueFallback(rawVal)}</span>
                              </span>
                            ) : col.tipo === 'numero' && typeof rawVal === 'number' ? (
                              <span>{formatNumberWithDecimals(rawVal, col.decimali)}</span>
                            ) : col.tipo === 'seleziona' && typeof rawVal === 'string' && rawVal ? (
                              renderOptionPill(
                                rawVal,
                                col.opzioni?.find((o) => o.valore === rawVal),
                                false,
                              )
                            ) : col.tipo === 'stato' && typeof rawVal === 'string' && rawVal ? (
                              renderOptionPill(
                                rawVal,
                                col.opzioni?.find((o) => o.valore === rawVal),
                                true,
                              )
                            ) : col.tipo === 'selezione-multipla' && Array.isArray(rawVal) ? (
                              <div className="notion-cell-pills-wrap">
                                {rawVal.map((item, idx) => {
                                  const s = String(item);
                                  const opt = col.opzioni?.find((o) => o.valore === s);
                                  return (
                                    <React.Fragment key={`${s}-${idx}`}>
                                      {renderOptionPill(s, opt, false)}
                                    </React.Fragment>
                                  );
                                })}
                              </div>
                            ) : (col.tipo === 'data' ||
                                col.tipo === 'creato' ||
                                col.tipo === 'modificato') &&
                              typeof rawVal === 'string' &&
                              rawVal ? (
                              <span>{formatItalianDate(rawVal) ?? rawVal}</span>
                            ) : col.tipo === 'url' && typeof rawVal === 'string' && rawVal ? (
                              <a
                                href={rawVal}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="notion-cell-link"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <LinkIcon size={12} /> {rawVal}
                              </a>
                            ) : col.tipo === 'email' && typeof rawVal === 'string' && rawVal ? (
                              <a
                                href={`mailto:${rawVal}`}
                                className="notion-cell-link"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Mail size={12} /> {rawVal}
                              </a>
                            ) : col.tipo === 'telefono' && typeof rawVal === 'string' && rawVal ? (
                              <a
                                href={`tel:${rawVal}`}
                                className="notion-cell-link"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Phone size={12} /> {rawVal}
                              </a>
                            ) : (
                              <span>{formatRawValueFallback(rawVal)}</span>
                            )}
                          </div>
                        )}

                        {/* Modalità editor inline per la cella */}
                        {isEditing && (
                          <div
                            className="notion-cell-editor-wrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(col.tipo === 'testo' ||
                              col.tipo === 'url' ||
                              col.tipo === 'email' ||
                              col.tipo === 'telefono' ||
                              col.tipo === 'numero') && (
                              <input
                                type={col.tipo === 'numero' ? 'number' : 'text'}
                                step="any"
                                className="notion-inline-cell-input"
                                value={cellDraftText}
                                onChange={(e) => setCellDraftText(e.target.value)}
                                onBlur={() => {
                                  const trimmed = cellDraftText.trim();
                                  if (trimmed === '') {
                                    void handlePatchCellValue(row, col, undefined, true);
                                  } else if (col.tipo === 'numero') {
                                    const n = Number(trimmed);
                                    void handlePatchCellValue(
                                      row,
                                      col,
                                      Number.isFinite(n) ? n : trimmed,
                                    );
                                  } else {
                                    void handlePatchCellValue(row, col, trimmed);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    (e.target as HTMLInputElement).blur();
                                  }
                                  if (e.key === 'Escape') {
                                    setEditingCell(null);
                                  }
                                }}
                                autoFocus
                              />
                            )}

                            {(col.tipo === 'seleziona' ||
                              col.tipo === 'stato' ||
                              col.tipo === 'selezione-multipla') && (
                              <div className="notion-table-popover notion-cell-select-popover">
                                <input
                                  type="text"
                                  className="notion-input"
                                  placeholder="Cerca o crea opzione..."
                                  value={cellOptionSearch}
                                  onChange={(e) => setCellOptionSearch(e.target.value)}
                                  autoFocus
                                />
                                <div className="notion-cell-options-list">
                                  {(col.opzioni ?? [])
                                    .filter(
                                      (o) =>
                                        !cellOptionSearch.trim() ||
                                        o.valore
                                          .toLowerCase()
                                          .includes(cellOptionSearch.toLowerCase()),
                                    )
                                    .map((opt) => {
                                      const curMulti = Array.isArray(rawVal)
                                        ? rawVal.map(String)
                                        : [];
                                      const isSelected =
                                        col.tipo === 'selezione-multipla'
                                          ? curMulti.includes(opt.valore)
                                          : rawVal === opt.valore;
                                      return (
                                        <button
                                          key={opt.valore}
                                          type="button"
                                          className={`notion-cell-option-btn ${isSelected ? 'is-selected' : ''}`}
                                          onClick={() => {
                                            if (col.tipo === 'selezione-multipla') {
                                              const next = isSelected
                                                ? curMulti.filter((v) => v !== opt.valore)
                                                : [...curMulti, opt.valore];
                                              void handlePatchCellValue(row, col, next);
                                            } else {
                                              void handlePatchCellValue(row, col, opt.valore);
                                            }
                                          }}
                                        >
                                          {renderOptionPill(
                                            opt.valore,
                                            opt,
                                            col.tipo === 'stato',
                                          )}
                                          {isSelected && <Check size={12} />}
                                        </button>
                                      );
                                    })}

                                  {cellOptionSearch.trim() &&
                                    !(col.opzioni ?? []).some(
                                      (o) =>
                                        o.valore.toLowerCase() ===
                                        cellOptionSearch.trim().toLowerCase(),
                                    ) && (
                                      <button
                                        type="button"
                                        className="notion-cell-option-btn is-create"
                                        onClick={() =>
                                          void handleCreateOptionInCell(
                                            row,
                                            col,
                                            cellOptionSearch.trim(),
                                          )
                                        }
                                      >
                                        <Plus size={12} /> Crea "{cellOptionSearch.trim()}"
                                      </button>
                                    )}
                                </div>
                                <div className="notion-submenu-actions">
                                  <button
                                    type="button"
                                    className="notion-vista-btn-ghost"
                                    onClick={() =>
                                      void handlePatchCellValue(
                                        row,
                                        col,
                                        col.tipo === 'selezione-multipla' ? [] : undefined,
                                        col.tipo !== 'selezione-multipla',
                                      )
                                    }
                                  >
                                    Svuota
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-vista-btn"
                                    onClick={() => setEditingCell(null)}
                                  >
                                    Chiudi
                                  </button>
                                </div>
                              </div>
                            )}

                            {col.tipo === 'data' && (
                              <div className="notion-table-popover notion-cell-date-popover">
                                <label className="notion-submenu-label">Data inizio:</label>
                                <input
                                  type="date"
                                  className="notion-input"
                                  value={dateStartDraft}
                                  onChange={(e) => setDateStartDraft(e.target.value)}
                                />
                                <label className="notion-submenu-label">Ora (opzionale):</label>
                                <input
                                  type="time"
                                  className="notion-input"
                                  value={dateTimeDraft}
                                  onChange={(e) => setDateTimeDraft(e.target.value)}
                                />
                                <label className="notion-popover-check-row" style={{ marginTop: 4 }}>
                                  <input
                                    type="checkbox"
                                    checked={dateHasEndDraft}
                                    onChange={(e) => setDateHasEndDraft(e.target.checked)}
                                  />
                                  <span>Data fine (intervallo)</span>
                                </label>
                                {dateHasEndDraft && (
                                  <input
                                    type="date"
                                    className="notion-input"
                                    value={dateEndDraft}
                                    onChange={(e) => setDateEndDraft(e.target.value)}
                                  />
                                )}
                                <div className="notion-submenu-actions" style={{ marginTop: 8 }}>
                                  <button
                                    type="button"
                                    className="notion-vista-btn is-primary"
                                    onClick={() => {
                                      if (!dateStartDraft) {
                                        void handlePatchCellValue(row, col, undefined, true);
                                        return;
                                      }
                                      const startFull = dateTimeDraft
                                        ? `${dateStartDraft}T${dateTimeDraft}`
                                        : dateStartDraft;
                                      const composed =
                                        dateHasEndDraft && dateEndDraft
                                          ? `${startFull}/${dateEndDraft}`
                                          : startFull;
                                      void handlePatchCellValue(row, col, composed);
                                    }}
                                  >
                                    Salva
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-vista-btn-ghost"
                                    onClick={() =>
                                      void handlePatchCellValue(row, col, undefined, true)
                                    }
                                  >
                                    Rimuovi
                                  </button>
                                  <button
                                    type="button"
                                    className="notion-vista-btn"
                                    onClick={() => setEditingCell(null)}
                                  >
                                    Chiudi
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}

                  <td className="notion-td-empty-spacer" />
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Piè di pagina della tabella: "+ Nuova riga" e "Mostra altre" */}
      <div className="notion-table-footer">
        <button
          type="button"
          className="notion-table-add-row-btn"
          disabled={!queryData?.canAddRow}
          title={
            queryData?.canAddRow
              ? 'Crea una nuova pagina riga'
              : 'Nuova riga è disponibile solo per database e sottopagine dirette'
          }
          onClick={() => void handleAddRow()}
        >
          <Plus size={14} /> Nuova riga
        </button>

        {displayedRows.length > visibleLimit && (
          <button
            type="button"
            className="notion-vista-btn"
            onClick={() => setVisibleLimit((prev) => prev + 100)}
          >
            Mostra altre ({displayedRows.length - visibleLimit} rimanenti)
          </button>
        )}
      </div>

      {/* Modale di conferma archiviazione riga */}
      {confirmArchiveRow && (
        <div className="notion-table-warning-banner" style={{ marginTop: 6 }}>
          <Archive size={14} />
          <span>
            Archiviare la riga <strong>{confirmArchiveRow.title}</strong> (
            <code>{confirmArchiveRow.managePath}</code>)? La pagina verrà spostata nella cartella di
            archivio senza cancellare alcun dato.
          </span>
          <button
            type="button"
            className="notion-vista-btn is-danger"
            onClick={() => void handleConfirmArchiveRow()}
          >
            Archivia
          </button>
          <button
            type="button"
            className="notion-vista-btn"
            onClick={() => setConfirmArchiveRow(null)}
          >
            Annulla
          </button>
        </div>
      )}
    </div>
  );
};
