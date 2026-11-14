import React from 'react';
import { Box, Inline, Text, xcss, useTheme } from '@forge/react';

// Status chips: tint from ADS tokens, unique shape per status, text label in
// color.text. Never colour alone. color.text.warning is never used for a
// label; the warning tone appears only on the bold shape glyph.
const CHIP = {
  DUE: { bg: 'color.background.danger', glyph: '◆', glyphColor: 'color.text.danger', label: 'Due' },
  UPCOMING: { bg: 'color.background.warning', glyph: '◧', glyphColor: 'color.text.warning', label: 'Upcoming' },
  ON_TRACK: { bg: 'color.background.success', glyph: '○', glyphColor: 'color.text.success', label: 'On track' },
};

const chipStyle = (bg) =>
  xcss({
    backgroundColor: bg,
    paddingInline: 'space.100',
    paddingBlock: 'space.025',
    borderRadius: 'border.radius.200',
    display: 'inline-block',
  });

export function StatusChip({ status }) {
  const c = CHIP[status];
  if (!c) return <Text color="color.text.subtle">Check dates</Text>;
  return (
    <Box xcss={chipStyle(c.bg)}>
      <Inline space="space.075" alignBlock="center">
        <Text weight="bold" color={c.glyphColor}>
          {c.glyph}
        </Text>
        <Text weight="medium" color="color.text">
          {c.label}
        </Text>
      </Inline>
    </Box>
  );
}

// Fides Umber identity moment: one thin bar on the board header only.
// UI Kit xcss accepts raw colour values for colour props; the umber hex is
// switched by the host colour mode. Everything else uses ADS tokens.
export function UmberRule() {
  const theme = useTheme();
  const dark = theme?.colorMode === 'dark';
  return (
    <Box
      xcss={xcss({
        height: '3px',
        width: '48px',
        borderRadius: 'border.radius.100',
        backgroundColor: dark ? '#E0AB86' : '#77441A',
      })}
    />
  );
}

export function Footer({ text }) {
  return (
    <Box xcss={xcss({ paddingBlockStart: 'space.200' })}>
      <Text size="small" color="color.text.subtle">
        {text || 'Fides tracks dates and obligations; it is not legal advice.'}
      </Text>
    </Box>
  );
}

export const card = xcss({
  backgroundColor: 'elevation.surface.raised',
  boxShadow: 'elevation.shadow.raised',
  borderRadius: 'border.radius.200',
  padding: 'space.200',
});
