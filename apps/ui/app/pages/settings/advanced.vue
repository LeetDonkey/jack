<template>
  <div class="space-y-10">
    <!-- Settings > Advanced: rarely changed, and About. -->
    <TorznabSection />

    <USeparator />

    <OtherKeysSection />

    <USeparator />

    <!-- Also the home for required third-party attribution (TMDB). -->
    <SettingsSection
      id="about"
      title="About"
      description="Which build of jack this is, and the data it relies on."
    >
      <AboutCard />
    </SettingsSection>
  </div>
</template>
