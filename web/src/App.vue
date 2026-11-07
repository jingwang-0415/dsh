<template>
  <div class="app">
    <nav class="nav">
      <RouterLink to="/">总览</RouterLink>
      <RouterLink to="/compare">分支对比</RouterLink>
      <RouterLink to="/crossrepo">跨仓对比</RouterLink>
    </nav>
    <RouterView />
  </div>
</template>
