function setHeroIcon(heroClass, iconId, element) {
  // Find the target icon image inside the clicked element
  const iconImage = element.querySelector('.hero-avatar-icon');
  
  if (iconImage) {
    switch(heroClass) {
      case 'pyra':
        iconImage.src = 'image_1d431b92.JPG';
        break;
      case 'sylph':
        iconImage.src = 'image_e51741b7.JPG';
        break;
      case 'valen':
        iconImage.src = 'image_2e90c1d9.JPG';
        break;
      case 'nyx':
        iconImage.src = 'image_42205d6.JPG';
        break;
      case 'storm-knight':
        iconImage.src = 'image_4b6fbf95a.JPG';
        break;
      case 'ironclad-titan':
        iconImage.src = 'image_9b984ce7.JPG';
        break;
      case 'chrono-warden':
        iconImage.src = 'image_a4f1655c.JPG';
        break;
      case 'sky-valkyrie':
        iconImage.src = 'image_a9978665.JPG';
        break;
      case 'void-necromancer':
        iconImage.src = 'image_b2781538.JPG';
        break;
      case 'blood-berserker':
        iconImage.src = 'image_d3c262a5.JPG';
        break;
      case 'astral-archmage':
        iconImage.src = 'image_e1196f4d.JPG';
        break;
    }
  }
  console.log('Activated Hero Class: ' + heroClass);
}
