function setHeroIcon(heroClass, iconId, element) {
  // Find the target icon image inside the clicked element
  const iconImage = element.querySelector('.hero-avatar-icon');
  
  if (iconImage) {
    switch(heroClass) {
      case 'pyra':
        iconImage.src = 'image_1d431b92.jpg';
        break;
      case 'sylph':
        iconImage.src = 'image_e51741b7.jpg';
        break;
      case 'valen':
        iconImage.src = 'image_4b6fe95a.jpg';
        break;
      case 'nyx':
        iconImage.src = 'image_42205d6.jpg';
        break;
      case 'storm-knight':
        iconImage.src = 'image_4b6fbf95a.jpg';
        break;
      case 'ironclad-titan':
        iconImage.src = 'image_9b984ce7.jpg';
        break;
      case 'chrono-warden':
        iconImage.src = 'image_a4f1655c.jpg';
        break;
      case 'sky-valkyrie':
        iconImage.src = 'image_a9978665.jpg';
        break;
      case 'void-necromancer':
        iconImage.src = 'image_b2781538.jpg';
        break;
      case 'blood-berserker':
        iconImage.src = 'image_2e90c1d9.jpg';
        break;
      case 'astral-archmage':
        iconImage.src = 'image_e1196f4d.jpg';
        break;
    }
  }
  console.log('Activated Hero Class: ' + heroClass);
}
