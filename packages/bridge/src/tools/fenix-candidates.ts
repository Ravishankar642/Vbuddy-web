/**
 * Candidate Fenix A320 local variables (L:vars) for the FCU and EFIS panels.
 *
 * THESE ARE UNVERIFIED GUESSES based on Fenix's naming pattern
 * (N_ = number on a display, E_ = rotary encoder counter, S_ = switch/button,
 * I_ = indicator light, B_ = boolean state). SimConnect cannot list L:vars and
 * returns 0 for names that don't exist, so the discovery tool verifies them by
 * watching which ones change while you operate the real cockpit controls.
 *
 * Add more with --var NAME or --vars-file <file> (one name per line).
 */
export const FENIX_CANDIDATES: Record<string, string[]> = {
  "FCU displays": ["N_FCU_SPEED", "N_FCU_HEADING", "N_FCU_ALTITUDE", "N_FCU_VS", "N_FCU_VERTICAL_SPEED"],
  "FCU knobs (turn)": ["E_FCU_SPEED", "E_FCU_HEADING", "E_FCU_ALTITUDE", "E_FCU_VS", "E_FCU_VERTICAL_SPEED"],
  "FCU knobs (push/pull)": ["S_FCU_SPEED", "S_FCU_HEADING", "S_FCU_ALTITUDE", "S_FCU_VERTICAL_SPEED", "S_FCU_VS", "S_FCU_ALTITUDE_SCALE"],
  "FCU buttons": [
    "S_FCU_AP1",
    "S_FCU_AP2",
    "S_FCU_ATHR",
    "S_FCU_LOC",
    "S_FCU_APPR",
    "S_FCU_EXPED",
    "S_FCU_SPD_MACH",
    "S_FCU_HDGVS_TRKFPA",
    "S_FCU_METRIC_ALT",
  ],
  "FCU lights": [
    "I_FCU_AP1",
    "I_FCU_AP2",
    "I_FCU_ATHR",
    "I_FCU_LOC",
    "I_FCU_APPR",
    "I_FCU_EXPED",
    "I_FCU_SPEED_MANAGED",
    "I_FCU_HEADING_MANAGED",
    "I_FCU_ALTITUDE_MANAGED",
  ],
  "FCU display states": [
    "B_FCU_SPEED_DASHED",
    "B_FCU_HEADING_DASHED",
    "B_FCU_VERTICALSPEED_DASHED",
    "B_FCU_SPEED_MACH",
    "B_FCU_TRKFPA",
    "B_FCU_POWER",
  ],
  "EFIS captain": [
    "S_FCU_EFIS1_BARO_MODE",
    "S_FCU_EFIS1_BARO_STD",
    "E_FCU_EFIS1_BARO",
    "N_FCU_EFIS1_BARO_HPA",
    "N_FCU_EFIS1_BARO_INCH",
    "S_FCU_EFIS1_ND_MODE",
    "S_FCU_EFIS1_ND_RANGE",
    "S_FCU_EFIS1_FD",
    "S_FCU_EFIS1_LS",
    "S_FCU_EFIS1_CSTR",
    "S_FCU_EFIS1_WPT",
    "S_FCU_EFIS1_VORD",
    "S_FCU_EFIS1_NDB",
    "S_FCU_EFIS1_ARPT",
  ],
  "EFIS first officer": [
    "S_FCU_EFIS2_BARO_MODE",
    "S_FCU_EFIS2_BARO_STD",
    "E_FCU_EFIS2_BARO",
    "S_FCU_EFIS2_ND_MODE",
    "S_FCU_EFIS2_ND_RANGE",
    "S_FCU_EFIS2_FD",
    "S_FCU_EFIS2_LS",
  ],
};
