/**
 * icons.tsx — the app's icon vocabulary.
 *
 * Pages MUST NOT import from "lucide-react" directly. Import from here so an
 * RFI is drawn with the same glyph on every screen, and so a single edit can
 * re-point a concept at a better icon.
 *
 * Icons are named for MEANING (IconSubmittal), never for shape (IconClipboard).
 *
 * Every export is a drop-in <svg> component accepting all LucideProps plus a
 * `size` shorthand. Defaults: 16px, 1.75 stroke — tuned to sit optically level
 * with 13-14px UI text.
 *
 *   <IconRfi />                       // 16px, 1.75 stroke
 *   <IconRfi size={20} />
 *   <IconRfi className="text-danger-fg" />
 *   <IconSpinner size="sm" />
 */
import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpNarrowWide,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  Bell,
  BellOff,
  BookOpenCheck,
  BookOpenText,
  Bookmark,
  Box,
  Boxes,
  Bug,
  Building2,
  Calendar,
  CalendarCheck,
  CalendarRange,
  Camera,
  ChartColumn,
  ChartGantt,
  ChartLine,
  ChartPie,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  CircleStop,
  CircleX,
  ClipboardCheck,
  Clock,
  Cloud,
  CloudOff,
  CloudSun,
  Code,
  Coins,
  Columns3,
  Command,
  Compass,
  Contact,
  Copy,
  CreditCard,
  Crosshair,
  Database,
  Download,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileBadge,
  FileCheck,
  FileDown,
  FilePenLine,
  FileQuestionMark,
  FileSpreadsheet,
  FileStack,
  FileText,
  FileUp,
  Files,
  FingerprintPattern,
  Flag,
  Folder,
  FolderInput,
  FolderKanban,
  FolderOpen,
  Funnel,
  Gauge,
  Gavel,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Globe,
  GraduationCap,
  GripVertical,
  Handshake,
  HardHat,
  Highlighter,
  Image,
  Inbox,
  Info,
  KeyRound,
  Keyboard,
  LandPlot,
  Landmark,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Leaf,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListTodo,
  LoaderCircle,
  Lock,
  LockOpen,
  LogOut,
  Mail,
  Map,
  MapPin,
  MapPinned,
  Maximize2,
  Menu,
  MessageSquare,
  Microscope,
  Milestone,
  Minimize2,
  Minus,
  Monitor,
  Moon,
  Move,
  NotebookPen,
  OctagonAlert,
  Orbit,
  Package,
  Palette,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pause,
  PencilRuler,
  Phone,
  Pin,
  Play,
  Plug,
  Plus,
  Presentation,
  Printer,
  QrCode,
  ReceiptText,
  Redo2,
  RefreshCw,
  RotateCcwClock,
  Rows3,
  Ruler,
  Save,
  Scale,
  Scan,
  ScrollText,
  Search,
  SearchCheck,
  Send,
  Server,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  ShieldUser,
  ShoppingCart,
  Signature,
  Slash,
  SlidersHorizontal,
  Sparkles,
  Split,
  SquarePen,
  Stamp,
  Star,
  StickyNote,
  Store,
  Sun,
  Table2,
  Tag,
  Target,
  Terminal,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Truck,
  Umbrella,
  Undo2,
  Upload,
  User,
  UserPlus,
  Users,
  UsersRound,
  Video,
  Wallet,
  WifiOff,
  Workflow,
  Wrench,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { cx } from "./cx";
import type { Tone } from "./tokens";

/* ------------------------------------------------------------------ sizing */

/** Named icon sizes, in px. Pair `xs/sm` with text-2xs/text-xs. */
export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  "2xl": 32,
} as const;

export type IconSizeName = keyof typeof ICON_SIZE;

/** Default rendered size in px. */
export const ICON_DEFAULT_SIZE = ICON_SIZE.md;
/** Default stroke width. 2 (lucide's default) is too heavy at 16px. */
export const ICON_STROKE = 1.75;
/** Stroke for emphasis (empty-state illustrations, large marks). */
export const ICON_STROKE_BOLD = 2;
/** Stroke for large decorative marks. */
export const ICON_STROKE_LIGHT = 1.5;

export function resolveIconSize(size: IconSizeName | number | undefined): number {
  if (typeof size === "number") return size;
  if (typeof size === "string" && size in ICON_SIZE) return ICON_SIZE[size];
  return ICON_DEFAULT_SIZE;
}

/* ------------------------------------------------------------------- types */

export type { LucideIcon, LucideProps };

/** Props accepted by every icon in this module. */
export interface IconProps extends Omit<LucideProps, "size" | "ref"> {
  /** px number or a named step from ICON_SIZE. Default "md" (16). */
  size?: IconSizeName | number;
}

/** The shape of every export in this file. */
export type IconComponent = ReturnType<typeof makeIcon>;

/* ----------------------------------------------------------------- factory */

function makeIcon(Base: LucideIcon, name: string) {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>(function Icon(
    { size, strokeWidth, className, ...rest },
    ref,
  ) {
    return (
      <Base
        ref={ref}
        size={resolveIconSize(size)}
        strokeWidth={strokeWidth ?? ICON_STROKE}
        className={cx("shrink-0", className)}
        aria-hidden={
          rest["aria-label"] ?? rest["aria-labelledby"] ?? rest.role
            ? undefined
            : true
        }
        focusable="false"
        {...rest}
      />
    );
  });
  Wrapped.displayName = name;
  return Wrapped;
}

/* -------------------------------------------- Structure & navigation */

/** Company / project home */
export const IconDashboard = /* @__PURE__ */ makeIcon(LayoutDashboard, "IconDashboard");
/** A project record */
export const IconProject = /* @__PURE__ */ makeIcon(FolderKanban, "IconProject");
/** A company / tenant */
export const IconCompany = /* @__PURE__ */ makeIcon(Building2, "IconCompany");
/** A physical site or location on a project */
export const IconSite = /* @__PURE__ */ makeIcon(MapPinned, "IconSite");
/** People & companies directory */
export const IconDirectory = /* @__PURE__ */ makeIcon(Contact, "IconDirectory");
/** Administration */
export const IconAdmin = /* @__PURE__ */ makeIcon(ShieldUser, "IconAdmin");
export const IconSettings = /* @__PURE__ */ makeIcon(Settings, "IconSettings");
export const IconMenu = /* @__PURE__ */ makeIcon(Menu, "IconMenu");
/** Toggle the primary sidebar */
export const IconPanelLeft = /* @__PURE__ */ makeIcon(PanelLeft, "IconPanelLeft");
/** Toggle the inspector */
export const IconPanelRight = /* @__PURE__ */ makeIcon(PanelRight, "IconPanelRight");
export const IconSidebarCollapse = /* @__PURE__ */ makeIcon(ChevronsLeft, "IconSidebarCollapse");
export const IconSidebarExpand = /* @__PURE__ */ makeIcon(ChevronsRight, "IconSidebarExpand");
export const IconLogout = /* @__PURE__ */ makeIcon(LogOut, "IconLogout");
/** Notifications */
export const IconBell = /* @__PURE__ */ makeIcon(Bell, "IconBell");
export const IconBellOff = /* @__PURE__ */ makeIcon(BellOff, "IconBellOff");
export const IconHelp = /* @__PURE__ */ makeIcon(CircleQuestionMark, "IconHelp");
/** Shortcut help */
export const IconKeyboard = /* @__PURE__ */ makeIcon(Keyboard, "IconKeyboard");
/** Command palette (⌘K) */
export const IconCommand = /* @__PURE__ */ makeIcon(Command, "IconCommand");

/* ---------------------------------------------- Documents & drawings */

export const IconDocument = /* @__PURE__ */ makeIcon(FileText, "IconDocument");
export const IconFile = /* @__PURE__ */ makeIcon(File, "IconFile");
export const IconFiles = /* @__PURE__ */ makeIcon(Files, "IconFiles");
export const IconFolder = /* @__PURE__ */ makeIcon(Folder, "IconFolder");
export const IconFolderOpen = /* @__PURE__ */ makeIcon(FolderOpen, "IconFolderOpen");
/** Drawing set / plan */
export const IconDrawing = /* @__PURE__ */ makeIcon(PencilRuler, "IconDrawing");
/** A single drawing sheet / revision stack */
export const IconSheet = /* @__PURE__ */ makeIcon(FileStack, "IconSheet");
/** Specification section */
export const IconSpec = /* @__PURE__ */ makeIcon(BookOpenText, "IconSpec");
export const IconSpreadsheet = /* @__PURE__ */ makeIcon(FileSpreadsheet, "IconSpreadsheet");
export const IconPhoto = /* @__PURE__ */ makeIcon(Image, "IconPhoto");
export const IconCamera = /* @__PURE__ */ makeIcon(Camera, "IconCamera");
export const IconVideo = /* @__PURE__ */ makeIcon(Video, "IconVideo");
export const IconAttachment = /* @__PURE__ */ makeIcon(Paperclip, "IconAttachment");
export const IconSignature = /* @__PURE__ */ makeIcon(Signature, "IconSignature");
/** Approval stamp */
export const IconStamp = /* @__PURE__ */ makeIcon(Stamp, "IconStamp");
/** Redline / markup */
export const IconMarkup = /* @__PURE__ */ makeIcon(Highlighter, "IconMarkup");

/* ------------------------------------------- Model & reality capture */

/** Federated model */
export const IconBim = /* @__PURE__ */ makeIcon(Boxes, "IconBim");
/** A single model / element */
export const IconModel = /* @__PURE__ */ makeIcon(Box, "IconModel");
/** Digital twin */
export const IconTwin = /* @__PURE__ */ makeIcon(Orbit, "IconTwin");
export const IconLayers = /* @__PURE__ */ makeIcon(Layers, "IconLayers");
/** Reality capture / point cloud */
export const IconScan = /* @__PURE__ */ makeIcon(Scan, "IconScan");
/** Measure */
export const IconRuler = /* @__PURE__ */ makeIcon(Ruler, "IconRuler");
/** Orientation */
export const IconCompass = /* @__PURE__ */ makeIcon(Compass, "IconCompass");
export const IconCrosshair = /* @__PURE__ */ makeIcon(Crosshair, "IconCrosshair");
export const IconMove = /* @__PURE__ */ makeIcon(Move, "IconMove");
export const IconZoomIn = /* @__PURE__ */ makeIcon(ZoomIn, "IconZoomIn");
export const IconZoomOut = /* @__PURE__ */ makeIcon(ZoomOut, "IconZoomOut");

/* ------------------------------------------------ Delivery workflows */

/** Request for information */
export const IconRfi = /* @__PURE__ */ makeIcon(FileQuestionMark, "IconRfi");
/** Submittal / shop drawing review */
export const IconSubmittal = /* @__PURE__ */ makeIcon(ClipboardCheck, "IconSubmittal");
/** Daily log / site diary */
export const IconDailyLog = /* @__PURE__ */ makeIcon(NotebookPen, "IconDailyLog");
/** Punch list / snag */
export const IconPunch = /* @__PURE__ */ makeIcon(ListChecks, "IconPunch");
export const IconTask = /* @__PURE__ */ makeIcon(ListTodo, "IconTask");
/** Site issue / observation */
export const IconIssue = /* @__PURE__ */ makeIcon(CircleAlert, "IconIssue");
/** Approval workflow */
export const IconWorkflow = /* @__PURE__ */ makeIcon(Workflow, "IconWorkflow");
/** Approved state */
export const IconApproval = /* @__PURE__ */ makeIcon(BadgeCheck, "IconApproval");
/** Meeting / minutes */
export const IconMeeting = /* @__PURE__ */ makeIcon(Presentation, "IconMeeting");
export const IconNote = /* @__PURE__ */ makeIcon(StickyNote, "IconNote");
export const IconComment = /* @__PURE__ */ makeIcon(MessageSquare, "IconComment");
/** Inspection / test */
export const IconInspection = /* @__PURE__ */ makeIcon(SearchCheck, "IconInspection");
/** Weather record on a daily log */
export const IconWeather = /* @__PURE__ */ makeIcon(CloudSun, "IconWeather");

/* ---------------------------------------------------------- Schedule */

/** Programme / schedule */
export const IconSchedule = /* @__PURE__ */ makeIcon(CalendarRange, "IconSchedule");
export const IconGantt = /* @__PURE__ */ makeIcon(ChartGantt, "IconGantt");
export const IconMilestone = /* @__PURE__ */ makeIcon(Milestone, "IconMilestone");
export const IconCalendar = /* @__PURE__ */ makeIcon(Calendar, "IconCalendar");
export const IconCalendarCheck = /* @__PURE__ */ makeIcon(CalendarCheck, "IconCalendarCheck");
export const IconClock = /* @__PURE__ */ makeIcon(Clock, "IconClock");
/** Audit / revision history */
export const IconHistory = /* @__PURE__ */ makeIcon(RotateCcwClock, "IconHistory");
export const IconTimeline = /* @__PURE__ */ makeIcon(GitCommitHorizontal, "IconTimeline");
/** Revision / version */
export const IconVersion = /* @__PURE__ */ makeIcon(GitBranch, "IconVersion");

/* ---------------------------------------------- Commercial & finance */

export const IconBudget = /* @__PURE__ */ makeIcon(Wallet, "IconBudget");
export const IconCost = /* @__PURE__ */ makeIcon(Coins, "IconCost");
/** Subcontract / purchase-order commitment */
export const IconCommitment = /* @__PURE__ */ makeIcon(Handshake, "IconCommitment");
/** Change order / variation */
export const IconChangeOrder = /* @__PURE__ */ makeIcon(GitPullRequestArrow, "IconChangeOrder");
/** Application for payment / invoice */
export const IconInvoice = /* @__PURE__ */ makeIcon(ReceiptText, "IconInvoice");
export const IconPayment = /* @__PURE__ */ makeIcon(CreditCard, "IconPayment");
export const IconContract = /* @__PURE__ */ makeIcon(FilePenLine, "IconContract");
/** Evidence ledger */
export const IconLedger = /* @__PURE__ */ makeIcon(BookOpenCheck, "IconLedger");
export const IconFinance = /* @__PURE__ */ makeIcon(Banknote, "IconFinance");
export const IconProcurement = /* @__PURE__ */ makeIcon(ShoppingCart, "IconProcurement");
/** Supplier / vendor */
export const IconVendor = /* @__PURE__ */ makeIcon(Store, "IconVendor");
/** Claim */
export const IconClaim = /* @__PURE__ */ makeIcon(FileBadge, "IconClaim");

/* -------------------------------------- Risk, assurance & governance */

export const IconAssurance = /* @__PURE__ */ makeIcon(ShieldCheck, "IconAssurance");
export const IconRisk = /* @__PURE__ */ makeIcon(ShieldAlert, "IconRisk");
export const IconCompliance = /* @__PURE__ */ makeIcon(FileCheck, "IconCompliance");
export const IconGovernance = /* @__PURE__ */ makeIcon(Scale, "IconGovernance");
/** Regulatory jurisdiction */
export const IconJurisdiction = /* @__PURE__ */ makeIcon(Landmark, "IconJurisdiction");
export const IconDispute = /* @__PURE__ */ makeIcon(Gavel, "IconDispute");
/** Forensic / delay analysis */
export const IconForensics = /* @__PURE__ */ makeIcon(Microscope, "IconForensics");
export const IconInsurance = /* @__PURE__ */ makeIcon(Umbrella, "IconInsurance");
export const IconWarranty = /* @__PURE__ */ makeIcon(ShieldPlus, "IconWarranty");
/** Provenance / evidence chain */
export const IconEvidence = /* @__PURE__ */ makeIcon(FingerprintPattern, "IconEvidence");
export const IconAudit = /* @__PURE__ */ makeIcon(ScrollText, "IconAudit");
export const IconSecurity = /* @__PURE__ */ makeIcon(KeyRound, "IconSecurity");
export const IconLock = /* @__PURE__ */ makeIcon(Lock, "IconLock");
export const IconUnlock = /* @__PURE__ */ makeIcon(LockOpen, "IconUnlock");

/* -------------------------------------------- Field, people & assets */

export const IconSafety = /* @__PURE__ */ makeIcon(HardHat, "IconSafety");
export const IconQuality = /* @__PURE__ */ makeIcon(BadgeCheck, "IconQuality");
export const IconEquipment = /* @__PURE__ */ makeIcon(Truck, "IconEquipment");
export const IconMaterial = /* @__PURE__ */ makeIcon(Package, "IconMaterial");
export const IconWorkforce = /* @__PURE__ */ makeIcon(UsersRound, "IconWorkforce");
export const IconUser = /* @__PURE__ */ makeIcon(User, "IconUser");
export const IconUsers = /* @__PURE__ */ makeIcon(Users, "IconUsers");
export const IconUserAdd = /* @__PURE__ */ makeIcon(UserPlus, "IconUserAdd");
export const IconTool = /* @__PURE__ */ makeIcon(Wrench, "IconTool");
/** Land parcel / acquisition */
export const IconLand = /* @__PURE__ */ makeIcon(LandPlot, "IconLand");
/** Sustainability / ESG */
export const IconEsg = /* @__PURE__ */ makeIcon(Leaf, "IconEsg");
export const IconMap = /* @__PURE__ */ makeIcon(Map, "IconMap");
export const IconLocation = /* @__PURE__ */ makeIcon(MapPin, "IconLocation");

/* ------------------------------------------------------ Intelligence */

/** Anything model-generated */
export const IconAi = /* @__PURE__ */ makeIcon(Sparkles, "IconAi");
export const IconInsight = /* @__PURE__ */ makeIcon(Lightbulb, "IconInsight");
export const IconAnalytics = /* @__PURE__ */ makeIcon(ChartColumn, "IconAnalytics");
export const IconChartBar = /* @__PURE__ */ makeIcon(ChartColumn, "IconChartBar");
export const IconChartLine = /* @__PURE__ */ makeIcon(ChartLine, "IconChartLine");
export const IconChartPie = /* @__PURE__ */ makeIcon(ChartPie, "IconChartPie");
export const IconBenchmark = /* @__PURE__ */ makeIcon(Gauge, "IconBenchmark");
export const IconLearning = /* @__PURE__ */ makeIcon(GraduationCap, "IconLearning");
export const IconActivity = /* @__PURE__ */ makeIcon(Activity, "IconActivity");
export const IconTrendUp = /* @__PURE__ */ makeIcon(TrendingUp, "IconTrendUp");
export const IconTrendDown = /* @__PURE__ */ makeIcon(TrendingDown, "IconTrendDown");
export const IconTarget = /* @__PURE__ */ makeIcon(Target, "IconTarget");

/* ---------------------------------------------------------- Platform */

export const IconIntegration = /* @__PURE__ */ makeIcon(Plug, "IconIntegration");
/** Bulk import / ingestion */
export const IconIngestion = /* @__PURE__ */ makeIcon(FolderInput, "IconIngestion");
export const IconInbox = /* @__PURE__ */ makeIcon(Inbox, "IconInbox");
export const IconDatabase = /* @__PURE__ */ makeIcon(Database, "IconDatabase");
export const IconServer = /* @__PURE__ */ makeIcon(Server, "IconServer");
export const IconGlobe = /* @__PURE__ */ makeIcon(Globe, "IconGlobe");
export const IconCloud = /* @__PURE__ */ makeIcon(Cloud, "IconCloud");
export const IconCloudOff = /* @__PURE__ */ makeIcon(CloudOff, "IconCloudOff");
export const IconOffline = /* @__PURE__ */ makeIcon(WifiOff, "IconOffline");
export const IconCode = /* @__PURE__ */ makeIcon(Code, "IconCode");
export const IconTerminal = /* @__PURE__ */ makeIcon(Terminal, "IconTerminal");
export const IconBug = /* @__PURE__ */ makeIcon(Bug, "IconBug");
export const IconQr = /* @__PURE__ */ makeIcon(QrCode, "IconQr");
export const IconZap = /* @__PURE__ */ makeIcon(Zap, "IconZap");

/* ----------------------------------------------------------- Actions */

export const IconSearch = /* @__PURE__ */ makeIcon(Search, "IconSearch");
export const IconFilter = /* @__PURE__ */ makeIcon(Funnel, "IconFilter");
/** Column / display settings */
export const IconFilterAdjust = /* @__PURE__ */ makeIcon(SlidersHorizontal, "IconFilterAdjust");
export const IconSort = /* @__PURE__ */ makeIcon(ArrowUpDown, "IconSort");
export const IconSortAsc = /* @__PURE__ */ makeIcon(ArrowUpNarrowWide, "IconSortAsc");
export const IconSortDesc = /* @__PURE__ */ makeIcon(ArrowDownWideNarrow, "IconSortDesc");
/** Group-by */
export const IconGroup = /* @__PURE__ */ makeIcon(Rows3, "IconGroup");
export const IconMore = /* @__PURE__ */ makeIcon(Ellipsis, "IconMore");
export const IconMoreVertical = /* @__PURE__ */ makeIcon(EllipsisVertical, "IconMoreVertical");
export const IconPlus = /* @__PURE__ */ makeIcon(Plus, "IconPlus");
export const IconMinus = /* @__PURE__ */ makeIcon(Minus, "IconMinus");
export const IconEdit = /* @__PURE__ */ makeIcon(SquarePen, "IconEdit");
export const IconTrash = /* @__PURE__ */ makeIcon(Trash2, "IconTrash");
export const IconCopy = /* @__PURE__ */ makeIcon(Copy, "IconCopy");
export const IconSave = /* @__PURE__ */ makeIcon(Save, "IconSave");
export const IconUndo = /* @__PURE__ */ makeIcon(Undo2, "IconUndo");
export const IconRedo = /* @__PURE__ */ makeIcon(Redo2, "IconRedo");
export const IconRefresh = /* @__PURE__ */ makeIcon(RefreshCw, "IconRefresh");
export const IconDownload = /* @__PURE__ */ makeIcon(Download, "IconDownload");
export const IconUpload = /* @__PURE__ */ makeIcon(Upload, "IconUpload");
export const IconExport = /* @__PURE__ */ makeIcon(FileDown, "IconExport");
export const IconImport = /* @__PURE__ */ makeIcon(FileUp, "IconImport");
export const IconPrint = /* @__PURE__ */ makeIcon(Printer, "IconPrint");
export const IconShare = /* @__PURE__ */ makeIcon(Share2, "IconShare");
export const IconLink = /* @__PURE__ */ makeIcon(Link, "IconLink");
export const IconExternal = /* @__PURE__ */ makeIcon(ExternalLink, "IconExternal");
export const IconSend = /* @__PURE__ */ makeIcon(Send, "IconSend");
export const IconMail = /* @__PURE__ */ makeIcon(Mail, "IconMail");
export const IconPhone = /* @__PURE__ */ makeIcon(Phone, "IconPhone");
export const IconArchive = /* @__PURE__ */ makeIcon(Archive, "IconArchive");
export const IconPin = /* @__PURE__ */ makeIcon(Pin, "IconPin");
export const IconStar = /* @__PURE__ */ makeIcon(Star, "IconStar");
export const IconBookmark = /* @__PURE__ */ makeIcon(Bookmark, "IconBookmark");
export const IconFlag = /* @__PURE__ */ makeIcon(Flag, "IconFlag");
export const IconTag = /* @__PURE__ */ makeIcon(Tag, "IconTag");
export const IconDrag = /* @__PURE__ */ makeIcon(GripVertical, "IconDrag");
export const IconExpand = /* @__PURE__ */ makeIcon(Maximize2, "IconExpand");
export const IconCollapse = /* @__PURE__ */ makeIcon(Minimize2, "IconCollapse");
export const IconEye = /* @__PURE__ */ makeIcon(Eye, "IconEye");
export const IconEyeOff = /* @__PURE__ */ makeIcon(EyeOff, "IconEyeOff");
export const IconPlay = /* @__PURE__ */ makeIcon(Play, "IconPlay");
export const IconPause = /* @__PURE__ */ makeIcon(Pause, "IconPause");
export const IconStop = /* @__PURE__ */ makeIcon(CircleStop, "IconStop");

/* -------------------------------------------------- Feedback & state */

export const IconCheck = /* @__PURE__ */ makeIcon(Check, "IconCheck");
export const IconCheckCircle = /* @__PURE__ */ makeIcon(CircleCheck, "IconCheckCircle");
export const IconClose = /* @__PURE__ */ makeIcon(X, "IconClose");
export const IconCloseCircle = /* @__PURE__ */ makeIcon(CircleX, "IconCloseCircle");
export const IconWarning = /* @__PURE__ */ makeIcon(TriangleAlert, "IconWarning");
export const IconError = /* @__PURE__ */ makeIcon(OctagonAlert, "IconError");
export const IconInfo = /* @__PURE__ */ makeIcon(Info, "IconInfo");
export const IconAlert = /* @__PURE__ */ makeIcon(CircleAlert, "IconAlert");
/** Prefer <IconSpinner/> which adds the animation */
export const IconLoader = /* @__PURE__ */ makeIcon(LoaderCircle, "IconLoader");
export const IconCircle = /* @__PURE__ */ makeIcon(Circle, "IconCircle");
export const IconDot = /* @__PURE__ */ makeIcon(CircleDot, "IconDot");
export const IconEmpty = /* @__PURE__ */ makeIcon(Inbox, "IconEmpty");

/* ---------------------------------------------------- Views & layout */

export const IconGridView = /* @__PURE__ */ makeIcon(LayoutGrid, "IconGridView");
export const IconListView = /* @__PURE__ */ makeIcon(List, "IconListView");
export const IconBoardView = /* @__PURE__ */ makeIcon(Columns3, "IconBoardView");
export const IconTableView = /* @__PURE__ */ makeIcon(Table2, "IconTableView");
export const IconSplitView = /* @__PURE__ */ makeIcon(Split, "IconSplitView");
export const IconChevronDown = /* @__PURE__ */ makeIcon(ChevronDown, "IconChevronDown");
export const IconChevronUp = /* @__PURE__ */ makeIcon(ChevronUp, "IconChevronUp");
export const IconChevronLeft = /* @__PURE__ */ makeIcon(ChevronLeft, "IconChevronLeft");
export const IconChevronRight = /* @__PURE__ */ makeIcon(ChevronRight, "IconChevronRight");
export const IconChevronsUpDown = /* @__PURE__ */ makeIcon(ChevronsUpDown, "IconChevronsUpDown");
export const IconChevronsLeft = /* @__PURE__ */ makeIcon(ChevronsLeft, "IconChevronsLeft");
export const IconChevronsRight = /* @__PURE__ */ makeIcon(ChevronsRight, "IconChevronsRight");
export const IconArrowUp = /* @__PURE__ */ makeIcon(ArrowUp, "IconArrowUp");
export const IconArrowDown = /* @__PURE__ */ makeIcon(ArrowDown, "IconArrowDown");
export const IconArrowLeft = /* @__PURE__ */ makeIcon(ArrowLeft, "IconArrowLeft");
export const IconArrowRight = /* @__PURE__ */ makeIcon(ArrowRight, "IconArrowRight");
export const IconArrowUpRight = /* @__PURE__ */ makeIcon(ArrowUpRight, "IconArrowUpRight");
/** Breadcrumb separator */
export const IconSlash = /* @__PURE__ */ makeIcon(Slash, "IconSlash");

/* ------------------------------------------------------------- Theme */

export const IconSun = /* @__PURE__ */ makeIcon(Sun, "IconSun");
export const IconMoon = /* @__PURE__ */ makeIcon(Moon, "IconMoon");
export const IconSystem = /* @__PURE__ */ makeIcon(Monitor, "IconSystem");
export const IconPalette = /* @__PURE__ */ makeIcon(Palette, "IconPalette");
export const IconDensity = /* @__PURE__ */ makeIcon(Rows3, "IconDensity");

/* ------------------------------------------------------------- composites */

/** Spinning loader. Decorative by default; pass a label to announce it. */
export const IconSpinner = /* @__PURE__ */ forwardRef<SVGSVGElement, IconProps>(
  function IconSpinner({ className, ...rest }, ref) {
    return (
      <IconLoader
        ref={ref}
        className={cx("animate-spin motion-reduce:animate-none", className)}
        {...rest}
      />
    );
  },
);

/* ------------------------------------------------------------- tone lookup */


/** The canonical glyph for each semantic tone — alerts, toasts, inline hints. */
export const TONE_ICON: Record<Tone, IconComponent> = {
  neutral: IconInfo,
  accent: IconInfo,
  info: IconInfo,
  success: IconCheckCircle,
  warning: IconWarning,
  danger: IconError,
  highlight: IconAi,
};

export function toneIcon(tone: Tone): IconComponent {
  return TONE_ICON[tone];
}

/* ---------------------------------------------------------- module lookup */

/**
 * Route-segment → icon. Keyed by the first path segment of every module in
 * the app so navigation, breadcrumbs, search results and the command palette
 * all render the same glyph for a destination without hand-maintained lists.
 */
export const MODULE_ICON: Record<string, IconComponent> = {
  "": IconDashboard,
  dashboard: IconDashboard,
  projects: IconProject,
  directory: IconDirectory,
  admin: IconAdmin,
  notifications: IconBell,
  documents: IconDocument,
  drawings: IconDrawing,
  sheets: IconSheet,
  photos: IconPhoto,
  bim: IconBim,
  twin: IconTwin,
  rfis: IconRfi,
  submittals: IconSubmittal,
  dailylogs: IconDailyLog,
  punch: IconPunch,
  schedule: IconSchedule,
  commercial: IconBudget,
  contracts: IconContract,
  payments: IconPayment,
  finance: IconFinance,
  ledger: IconLedger,
  benchmarks: IconBenchmark,
  analytics: IconAnalytics,
  assurance: IconAssurance,
  governance: IconGovernance,
  risk: IconRisk,
  insurance: IconInsurance,
  disputes: IconDispute,
  forensics: IconForensics,
  jurisdiction: IconJurisdiction,
  esg: IconEsg,
  land: IconLand,
  workforce: IconWorkforce,
  learning: IconLearning,
  integrations: IconIntegration,
  ingestion: IconIngestion,
  ai: IconAi,
  safety: IconSafety,
  quality: IconQuality,
  equipment: IconEquipment,
  settings: IconSettings,
};

/** Icon for a route path such as "/projects/123/rfis". Falls back to a dot. */
export function moduleIcon(path: string): IconComponent {
  const segments = path.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const key = segments[i];
    if (key) {
      const hit = MODULE_ICON[key];
      if (hit) return hit;
    }
  }
  return MODULE_ICON[""] ?? IconDot;
}
